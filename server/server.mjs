// Monkey Kitchen server. No dependencies.
//   POST /hook      hook payloads, trimmed by scripts/hook.mjs
//   POST /shutdown  asks this server to exit (hook.mjs replaces a server from another version)
//   GET  /events    server-sent events: one v2 frame per change for the watched session (?session=<id>)
//   GET  /cook      ?session=<id>&id=<cookId>: one cook's full prompt, report and log
//   GET  /chef      ?session=<id>: the Head Chef's full log
//   GET  /state     every session in full, as JSON (debugging and tests)
//   GET  /health    {ok, app, version, root}
//   GET  /          the kitchen page

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UsageMeter } from './usage.mjs';

const PORT = Number(process.env.MONKEY_KITCHEN_PORT) || 4747;
const HOST = '127.0.0.1';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');
const VERSION = (() => { try { return String(JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version || ''); } catch { return ''; } })();
const IDLE_EXIT_MS = 12 * 60 * 60 * 1000;
const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
const ENDED_KEEP_MS = 30 * 60 * 1000;
const STALE_MS = Number(process.env.MONKEY_KITCHEN_STALE_MS) || 15 * 60 * 1000;
const SWEEP_MS = Number(process.env.MONKEY_KITCHEN_SWEEP_MS) || 20000;
const KEEPALIVE_MS = 20000;
const STOP_SLACK_MS = 1000; // hook stamps can trail the real event: a tool event this close after Stop belongs to the turn it ended
const MAX_SESSIONS = 50;
const BROADCAST_MS = 150;
const MAX_BACKLOG = 2 * 1024 * 1024; // an SSE client this far behind is dropped; it reconnects
const MAX_BODY = 5e6;

const BRIGADE = new Set(['sous-chef', 'chef-de-partie', 'frontend-cook', 'backend-cook', 'line-cook', 'taster', 'inspector', 'prep-cook', 'runner', 'dishwasher', 'scribe']);
const ROLE_NAME = {
  'head-chef': 'Head Chef', 'sous-chef': 'Sous Chef', 'chef-de-partie': 'Senior Cook', 'frontend-cook': 'Pastry Chef', 'backend-cook': 'Grill Cook',
  'line-cook': 'Line Cook', taster: 'Taster', inspector: 'Health Inspector', 'prep-cook': 'Prep Cook',
  runner: 'Runner', dishwasher: 'Dishwasher', scribe: 'Menu Scribe', stagiaire: 'Stagiaire',
};
// Events that belong to one cook. A cook not on the rail yet may be created by its SubagentStart, its first
// PreToolUse, or a SubagentStop that overtook both; once it has finished (`ended`) nothing creates it again.
const COOK_EVENTS = new Set(['SubagentStart', 'SubagentStop', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure']);
const CREATES_COOK = new Set(['SubagentStart', 'PreToolUse', 'SubagentStop']);
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);

const sessions = new Map();
const clients = new Set(); // { res, sid, follow, last }
const seen = new Set(); // recent _mk.ids, to drop duplicate deliveries
let lastEventAt = Date.now();

const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
// Long text (orders, tickets, reports): keeps line breaks, trims runs of spaces.
const clipLong = (s, n) => { s = String(s ?? '').replace(/[^\S\n]+/g, ' ').replace(/ ?\n[ \n]*/g, '\n').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
// Append a step to a cook's or the chef's log (newest last, 20 kept).
const step = (log, t, kind, text) => { log.push({ t, kind, text }); if (log.length > 20) log.splice(0, log.length - 20); };
const base = p => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';
const isAgentTool = t => t === 'Agent' || t === 'Task';
// Working or quiet: not finished, whatever the sweep thinks. 'done', 'failed' and 'lost' are finished.
const isActive = c => c.status === 'working' || c.status === 'quiet';
// Keep a Map or Set at or under max entries, dropping the oldest.
const trim = (coll, max) => { while (coll.size > max) coll.delete(coll.keys().next().value); };
const idOk = v => typeof v === 'string' && v.length >= 1 && v.length <= 128;
// A transcript is a local absolute .jsonl file; a network path would make the meter reach out over SMB.
const pathOk = v => typeof v === 'string' && v.length <= 4096 && !v.includes('\0') && !/^[\\/]{2}/.test(v) && /\.jsonl$/i.test(v) && path.isAbsolute(v);
const idle = () => ({ status: 'idle', activity: '' });
// A prompt may start with <system-reminder> blocks Claude Code added; what follows them is what was submitted.
const REMINDER = /^<system-reminder(?:\s[^>]*)?>[\s\S]*?<\/system-reminder>/;
function stripReminders(t) { t = String(t ?? '').trimStart(); let m; while ((m = REMINDER.exec(t))) t = t.slice(m[0].length).trimStart(); return t; }
// Turns Claude Code submits on its own (a subagent's report, a task or system notice) are not orders from the user.
// Only these exact openings count: a user can paste text that merely mentions the markers.
const HAND_BACK = ['Another Claude session sent a message:', '<agent-message from="'];
function isMachineTurn(rest) {
  if (!rest || rest.startsWith('[SYSTEM NOTIFICATION - NOT USER INPUT]') || rest.startsWith('<task-notification>')) return true;
  return HAND_BACK.some(lead => rest.startsWith(lead) && rest.slice(lead.length, lead.length + 400).includes('[Subagent hand-back]'));
}

// "monkey-kitchen:prep-cook" -> "prep-cook"; anything outside the brigade is a guest.
function roleOf(agentType) {
  const short = typeof agentType === 'string' ? agentType.split(':').pop() : '';
  return BRIGADE.has(short) ? short : 'stagiaire';
}

function describe(tool, input) {
  if (!input || typeof input !== 'object') input = {};
  switch (tool) {
    case 'Read': return ['read', `Reading ${base(input.file_path)}`];
    case 'Edit': case 'Write': case 'NotebookEdit': return ['write', `Writing ${base(input.file_path || input.notebook_path)}`];
    case 'Grep': return ['search', `Searching for "${clip(input.pattern, 100)}"`];
    case 'Glob': return ['search', `Looking for ${clip(input.pattern, 100)}`];
    case 'Bash': case 'PowerShell': return ['run', `Running: ${clip(input.description || input.command, 160)}`];
    case 'WebFetch': { try { return ['web', `Fetching ${new URL(input.url).host}`]; } catch { return ['web', 'Fetching a page']; } }
    case 'WebSearch': return ['web', `Looking up "${clip(input.query, 120)}"`];
    case 'Agent': case 'Task': return ['delegate', `Calling the ${ROLE_NAME[roleOf(input.subagent_type)]}`];
    default: return ['tool', typeof tool === 'string' && tool.startsWith('mcp__') ? `Using ${clip(tool.split('__').pop(), 60)}` : `Using ${clip(tool, 60)}`];
  }
}

function getSession(p) {
  let s = sessions.get(p.session_id);
  if (!s) {
    // Too many live sessions: the least recently active one makes room.
    if (sessions.size >= MAX_SESSIONS) { let old = null; for (const x of sessions.values()) if (!old || x.lastEventAt < old.lastEventAt) old = x; evict(old); }
    s = {
      id: p.session_id, cwd: '', project: 'session', fixedProject: false, startedAt: Date.now(), lastEventAt: Date.now(), mainAt: Date.now(),
      order: null, chef: idle(), chefLog: [], cooks: new Map(), pending: [], feed: [],
      calls: new Map(), known: new Map(), early: new Map(), ended: new Set(), promptAt: 0, lastStopAt: 0, endTimer: null,
      dropped: 0, lastDrop: null, usage: null, meter: null, scans: new Map(), effort: '', chefBefore: null, waitingAt: 0, waitingFor: null, lastToolAt: 0, lastToolBy: null,
    };
    sessions.set(s.id, s);
  }
  if (p.transcript_path && !s.meter) s.meter = new UsageMeter(p.transcript_path);
  // The project is the dir Claude Code was opened in; cwd drifts as the work moves, so only the first one counts.
  const dir = p._mk?.projectDir;
  if (dir && base(dir)) { s.project = base(dir); s.fixedProject = true; }
  if (p.cwd && !s.cwd) { s.cwd = String(p.cwd); if (!s.fixedProject) s.project = base(p.cwd) || s.project; }
  s.lastEventAt = Date.now();
  return s;
}

function evict(s) {
  clearTimeout(s.endTimer);
  for (const t of s.scans.values()) clearTimeout(t);
  s.scans.clear();
  if (sessions.get(s.id) === s) sessions.delete(s.id);
  broadcast();
}

// A guest cook's lines carry its agentType, so the page can name it.
function say(s, who, text, fail = false, agentType = '') {
  const e = { t: Date.now(), who, text, fail };
  if (who === 'stagiaire') e.agentType = String(agentType || '');
  s.feed.push(e);
  if (s.feed.length > 80) s.feed.splice(0, s.feed.length - 80);
}

// Every change to a cook's prompt bumps promptRev, so the page knows its cached full prompt is out of date.
function setTicket(c, ticket, prompt) { c.ticket = ticket; c.prompt = prompt; c.promptRev++; }

function finish(s, c, status) {
  c.status = status; c.endedAt = Date.now();
  s.ended.add(c.id); trim(s.ended, 1000);
}

function dropPlate(s, by, who, tool, agentType) {
  s.dropped++;
  s.lastDrop = { by, n: s.dropped };
  say(s, who, `dropped a plate (${clip(tool, 60)})`, true, agentType);
}

// Does a main-thread tool event come after the turn's last Stop? One stamped up to STOP_SLACK_MS after it still
// belongs to that turn (unless a newer prompt has started another).
const afterStop = (s, at) => at >= s.lastStopAt + (s.lastStopAt > s.promptAt ? STOP_SLACK_MS : 0);

function getCook(s, p, create) {
  let c = s.cooks.get(p.agent_id);
  if (c || !create || s.ended.has(p.agent_id)) return c || null;
  c = {
    id: p.agent_id, agentType: p.agent_type || '', role: roleOf(p.agent_type), ticket: '', prompt: '', report: '', log: [], activity: '', kind: 'think', status: 'working',
    startedAt: Date.now(), endedAt: 0, lastEventAt: Date.now(), tools: 0, model: '', tier: '', effort: '', promptRev: 0, guessCall: null,
  };
  const known = s.known.get(c.id);
  if (known) {
    // The Agent call's own response already named this cook.
    setTicket(c, known.ticket, known.prompt); c.model = known.model; s.known.delete(c.id);
  } else {
    // Guess the ticket the Head Chef wrote: oldest unclaimed call for this role. PostToolUse corrects it.
    const i = s.pending.findIndex(t => roleOf(t.type) === c.role);
    if (i >= 0) { const t = s.pending.splice(i, 1)[0]; setTicket(c, t.ticket, t.prompt); c.guessCall = t.id; }
  }
  const a = s.usage?.agents?.[c.id];
  if (a) { c.tier = a.tier; c.model ||= a.model; }
  s.cooks.set(c.id, c);
  say(s, c.role, c.ticket ? `picked up: ${c.ticket}` : 'clocked in', false, c.agentType);
  return c;
}

const asObject = r => {
  if (typeof r === 'string') { try { r = JSON.parse(r); } catch { return {}; } }
  return r && typeof r === 'object' ? r : {};
};

// The Agent tool's own response names the cook it started: the one reliable ticket-to-cook link.
function pairCook(s, p) {
  const agentId = asObject(p.tool_response).agentId;
  if (!agentId || typeof agentId !== 'string') return;
  const model = String(asObject(p.tool_response).resolvedModel || '');
  const call = s.calls.get(p.tool_use_id);
  // The response beat its own PreToolUse: remember the cook until the call shows up.
  if (!call) { if (p.tool_use_id) { s.early.set(p.tool_use_id, { agentId, model }); trim(s.early, 200); } return; }
  applyPair(s, p.tool_use_id, call, agentId, model);
}

function applyPair(s, id, call, agentId, resolved) {
  call.agentId = agentId;
  const model = resolved || call.model || '';
  s.pending = s.pending.filter(t => t.id !== id);
  const c = s.cooks.get(agentId);
  // Whoever was handed this ticket by guesswork was wrong; its own PostToolUse will give it the right one.
  for (const o of s.cooks.values()) if (o !== c && o.guessCall === id) { setTicket(o, '', ''); o.guessCall = null; }
  if (!c) { s.known.set(agentId, { ticket: call.ticket, prompt: call.prompt, model }); trim(s.known, 200); return; }
  setTicket(c, call.ticket, call.prompt); c.guessCall = null;
  if (model) c.model = model;
}

function handle(p) {
  if (!p || typeof p !== 'object' || !idOk(p.session_id) || typeof p.hook_event_name !== 'string' || !p.hook_event_name) return;
  if (p.agent_id != null && !idOk(p.agent_id)) return;
  for (const k of ['transcript_path', 'agent_transcript_path']) if (p[k] != null && !pathOk(p[k])) delete p[k];
  const mid = p._mk?.id;
  if (mid) { if (seen.has(mid)) return; seen.add(mid); trim(seen, 2000); }
  const at = Number(p._mk?.ts) || Date.now();
  const ev = p.hook_event_name;
  const s = getSession(p);
  const fromCook = p.agent_id != null;
  const level = typeof p.effort === 'string' ? p.effort : p.effort?.level;
  const effort = typeof level === 'string' ? clip(level, 20) : '';

  // "Needs you" ends when the thread that asked moves again. The asker is taken to be the thread whose tool call came
  // last before the notification (PreToolUse runs just before the permission prompt). A main-thread tool event and
  // Stop always clear it; a cook's tool event or SubagentStop only when that cook is the asker, so a sibling that
  // keeps working does not wipe a prompt raised for another cook.
  const unblock = cook => {
    if (s.chef.status !== 'waiting' || at <= s.waitingAt) return;
    if (cook ? cook.id !== s.waitingFor : !TOOL_EVENTS.has(ev)) return;
    s.chef = s.lastStopAt > s.promptAt || !s.chefBefore ? idle() : { ...s.chefBefore };
  };
  if (ev === 'PreToolUse' && at >= s.lastToolAt) { s.lastToolAt = at; s.lastToolBy = fromCook ? p.agent_id : null; }

  let c = null;
  if (fromCook && COOK_EVENTS.has(ev)) {
    c = getCook(s, p, CREATES_COOK.has(ev));
    if (!c) {
      if (ev === 'SubagentStop') { s.ended.add(p.agent_id); trim(s.ended, 1000); }
      // A plate dropped by a cook that is not on the rail still counts; it does not put the cook back.
      if (ev === 'PostToolUseFailure') { dropPlate(s, p.agent_id, roleOf(p.agent_type), p.tool_name, p.agent_type); broadcast(); }
      return;
    }
    // Quiet is not finished (a slow permission prompt, one long step): any event from it brings it back.
    if (c.status === 'quiet') c.status = 'working';
    // A finished cook stays finished: late async events must not bring it back.
    if (c.status !== 'working' && ev !== 'PostToolUseFailure') return;
    if (TOOL_EVENTS.has(ev) || ev === 'SubagentStop') unblock(c);
    if (c.status === 'working') { c.lastEventAt = Date.now(); if (effort) c.effort = effort; }
  } else if (!fromCook) { s.mainAt = Date.now(); if (effort) s.effort = effort; unblock(null); }
  const who = c ? c.role : 'head-chef';
  const whoType = c ? c.agentType : '';

  switch (ev) {
    case 'SessionStart':
      clearTimeout(s.endTimer);
      say(s, 'head-chef', `opened the kitchen in ${s.project}`);
      break;

    case 'UserPromptSubmit': {
      clearTimeout(s.endTimer);
      const text = stripReminders(p.prompt);
      if (isMachineTurn(text)) {
        // A cook's hand-back or a system notice wakes the Head Chef on the same order: nothing is cleared.
        s.promptAt = Math.max(s.promptAt, at);
        if (at >= s.lastStopAt) {
          if (s.order && s.order.status !== 'cooking') s.order.status = 'cooking';
          s.chef = { status: 'working', activity: "Reading a cook's report", kind: 'think' };
        }
        break;
      }
      // New order: clear finished tickets off the rail.
      for (const [id, k] of s.cooks) if (!isActive(k)) s.cooks.delete(id);
      s.chefLog = [];
      s.promptAt = Math.max(s.promptAt, at);
      // The Stop of this short turn may have been delivered first: then the order is already served.
      const served = at < s.lastStopAt;
      s.order = { text: clipLong(text, 4000), startedAt: Date.now(), status: served ? 'served' : 'cooking' };
      if (!served) s.chef = { status: 'working', activity: 'Reading the order', kind: 'think' };
      say(s, 'head-chef', `new order: ${clip(text, 240)}`);
      break;
    }

    case 'PreToolUse': {
      const [kind, what] = describe(p.tool_name, p.tool_input);
      if (c) {
        c.activity = what; c.kind = kind; c.tools++; step(c.log, at, kind, what);
      } else if (afterStop(s, at)) {
        s.chef = { status: 'working', activity: what, kind };
        step(s.chefLog, at, kind, what);
        if (s.order && s.order.status !== 'cooking') s.order.status = 'cooking';
      }
      if (isAgentTool(p.tool_name)) {
        const type = p.tool_input?.subagent_type || '';
        const prompt = clipLong(p.tool_input?.prompt, 4000);
        const ticket = clip(p.tool_input?.description || p.tool_input?.prompt, 200);
        const id = p.tool_use_id || null;
        if (id) { s.calls.set(id, { type, ticket, prompt, model: p.tool_input?.model || '' }); trim(s.calls, 200); }
        // The cook may already have clocked in if events arrived out of order.
        const early = id && s.early.get(id);
        if (early) { s.early.delete(id); applyPair(s, id, s.calls.get(id), early.agentId, early.model); } else {
          const waiting = [...s.cooks.values()].find(k => !k.ticket && k.status === 'working' && k.role === roleOf(type) && Date.now() - k.startedAt < 5000);
          if (waiting) { setTicket(waiting, ticket, prompt); waiting.guessCall = id; } else s.pending.push({ id, type, ticket, prompt, at: Date.now() });
        }
        say(s, who, `→ ${ROLE_NAME[roleOf(type)]}: ${ticket}`, false, whoType);
      }
      break;
    }

    case 'PostToolUse':
      if (!c && isAgentTool(p.tool_name)) pairCook(s, p);
      break;

    case 'PostToolUseFailure':
      dropPlate(s, p.agent_id || 'head-chef', who, p.tool_name, whoType);
      if (!c && isAgentTool(p.tool_name)) {
        s.pending = s.pending.filter(t => t.id !== p.tool_use_id);
        // Only a cook we can name can be failed (by the paired call, else the response); guessing by role hit the wrong plate.
        const k = s.cooks.get(s.calls.get(p.tool_use_id)?.agentId || s.early.get(p.tool_use_id)?.agentId || asObject(p.tool_response).agentId);
        if (k && isActive(k)) finish(s, k, 'failed');
      }
      break;

    case 'SubagentStart':
      break;

    case 'SubagentStop':
      if (!c) break; // no agent_id: nobody to finish
      finish(s, c, 'done');
      c.activity = ''; c.report = clipLong(p.last_assistant_message, 4000);
      say(s, c.role, `order up${c.tools ? ` (${c.tools} steps)` : ''}`, false, c.agentType);
      break;

    case 'Notification':
      // Raised before the turn's Stop but delivered after it: that turn is over, nobody is waiting.
      if (at < s.lastStopAt && s.lastStopAt > s.promptAt) break;
      if (!fromCook && /permission|idle|elicitation/i.test(p.notification_type || '')) {
        if (s.chef.status !== 'waiting') s.chefBefore = { ...s.chef };
        s.waitingAt = Math.max(s.waitingAt, at);
        s.waitingFor = s.lastToolBy;
        s.chef = { status: 'waiting', activity: `🛎️ ${clip(p.message || 'Needs you', 40)}` };
      }
      break;

    case 'Stop':
      if (at < s.promptAt) break; // belongs to an order that a newer prompt already replaced
      s.lastStopAt = Math.max(s.lastStopAt, at);
      s.chef = idle();
      if (s.order) s.order.status = 'served';
      say(s, 'head-chef', 'service! order served');
      break;

    case 'SessionEnd':
      s.chef = idle();
      s.lastStopAt = Math.max(s.lastStopAt, at);
      if (s.order) s.order.status = 'served';
      for (const k of s.cooks.values()) if (isActive(k)) finish(s, k, 'done');
      say(s, 'head-chef', 'closed the kitchen');
      clearTimeout(s.endTimer);
      s.endTimer = setTimeout(() => evict(s), ENDED_KEEP_MS);
      s.endTimer.unref?.();
      break;
  }

  s.pending = s.pending.filter(t => Date.now() - t.at < 60000);
  if (s.cooks.size > 60) for (const [id, k] of s.cooks) { if (s.cooks.size <= 40) break; if (!isActive(k)) s.cooks.delete(id); }
  if (ev === 'Stop' || ev === 'SubagentStop') {
    // Transcripts lag the hook: scan once now and again after they have settled.
    scheduleScan(s, 300, 'fast');
    scheduleScan(s, 2500, 'late', true);
  } else scheduleScan(s, 2500, 'tick');
  broadcast();
}

function scheduleScan(s, delay, key, reset = false) {
  if (!s.meter) return;
  if (s.scans.has(key)) { if (!reset) return; clearTimeout(s.scans.get(key)); }
  s.scans.set(key, setTimeout(() => { s.scans.delete(key); runScan(s); }, delay));
}

async function runScan(s) {
  try {
    const u = await s.meter.scan();
    if (!u || sessions.get(s.id) !== s) return;
    s.usage = u;
    // Stamp each cook with the tier it actually ran on.
    for (const [id, a] of Object.entries(u.agents)) {
      const c = s.cooks.get(id);
      if (c) { c.tier = a.tier; c.model ||= a.model; }
    }
    broadcast();
  } catch { /* transcript not readable yet */ }
}

// Time-based housekeeping: forget old sessions, and settle cooks and chefs whose events stopped coming.
function sweep() {
  const now = Date.now();
  let changed = false;
  for (const s of [...sessions.values()]) {
    if (now - s.lastEventAt > SESSION_IDLE_MS) { evict(s); continue; }
    // Quiet is not finished: the cook stays on the rail as 'quiet', and any later event makes it 'working' again.
    for (const c of s.cooks.values()) if (c.status === 'working' && now - c.lastEventAt > STALE_MS) { c.status = 'quiet'; changed = true; }
    // A cook killed by an interrupt never sends SubagentStop: quiet for 4 x STALE_MS more, it is given up as 'lost'.
    for (const c of s.cooks.values()) if (c.status === 'quiet' && now - c.lastEventAt > 5 * STALE_MS) {
      finish(s, c, 'lost'); c.activity = ''; changed = true;
      // Nobody is left to answer for: a bell rung for this cook goes with it.
      if (s.chef.status === 'waiting' && s.waitingFor === c.id) s.chef = s.lastStopAt > s.promptAt || !s.chefBefore ? idle() : { ...s.chefBefore };
    }
    // No Stop comes when the user interrupts a turn: a long-silent main thread with no cook at work means it stopped.
    const busy = [...s.cooks.values()].some(isActive);
    if (s.chef.status === 'working' && !busy && now - s.mainAt > STALE_MS) {
      s.chef = idle();
      if (s.order?.status === 'cooking') s.order.status = 'stopped';
      changed = true;
    }
  }
  if (changed) broadcast();
}

// Views. /state is everything; an SSE frame carries only what the page draws (long texts come from /cook and /chef).
const byRecent = () => [...sessions.values()].sort((a, b) => b.lastEventAt - a.lastEventAt);
const chefOut = s => ({ ...s.chef, kind: s.chef.kind || '', effort: s.effort || '' });
function fullView(s) {
  return {
    id: s.id, project: s.project, order: s.order, chef: chefOut(s), chefLog: s.chefLog,
    cooks: [...s.cooks.values()].map(({ guessCall, ...c }) => c), feed: s.feed.slice(-60), dropped: s.dropped, lastDrop: s.lastDrop, usage: s.usage,
  };
}
function frameView(s) {
  let usage = s.usage;
  if (usage) { const { agents, ...rest } = usage; usage = rest; }
  return {
    id: s.id, project: s.project, order: s.order, chef: chefOut(s), chefLog: s.chefLog.slice(-8),
    cooks: [...s.cooks.values()].map(({ guessCall, prompt, report, log, ...c }) => ({ ...c, log: log.slice(-8), promptLen: prompt.length, reportLen: report.length })),
    feed: s.feed.slice(-60), dropped: s.dropped, lastDrop: s.lastDrop, usage,
  };
}
const summary = s => ({
  id: s.id, project: s.project, lastEventAt: s.lastEventAt, chefStatus: s.chef.status, orderStatus: s.order?.status || null,
  working: [...s.cooks.values()].filter(c => c.status === 'working').length,
});
function snapshot() { return { now: Date.now(), sessions: byRecent().map(fullView) }; }

// One frame context per broadcast: the session list (every live session, they are small) and each watched
// session are serialised once, whoever watches them.
function frameContext() {
  const ordered = byRecent();
  return { latest: ordered[0] || null, list: JSON.stringify(ordered.map(summary)), views: new Map() };
}
function frameBody(cl, ctx) {
  const s = cl.follow ? ctx.latest : sessions.get(cl.sid) || null;
  let view = 'null';
  if (s) { if (!ctx.views.has(s.id)) ctx.views.set(s.id, JSON.stringify(frameView(s))); view = ctx.views.get(s.id); }
  return `"sessions":${ctx.list},"session":${view}}`;
}
function send(cl, body) {
  cl.last = body;
  // A client that stopped reading would make us buffer without end: drop it, it reconnects.
  if (cl.res.writableLength > MAX_BACKLOG) { clients.delete(cl); cl.res.destroy(); return; }
  cl.res.write(`data: {"v":2,"now":${Date.now()},${body}\n\n`);
}
// Unchanged frames are skipped unless forced (the keep-alive).
function flush(force = false) {
  if (!clients.size) return;
  const ctx = frameContext();
  for (const cl of [...clients]) { const body = frameBody(cl, ctx); if (force || body !== cl.last) send(cl, body); }
}

let pendingBroadcast = null;
function broadcast() {
  if (pendingBroadcast || !clients.size) return; // nobody watching: nothing to build
  pendingBroadcast = setTimeout(() => { pendingBroadcast = null; flush(); }, BROADCAST_MS);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const KITCHEN = { 'x-monkey-kitchen': '1' };
const HOSTS = new Set([`${HOST}:${PORT}`, `localhost:${PORT}`]);
const json = (res, status, obj) => res.writeHead(status, { 'content-type': MIME['.json'], 'cache-control': 'no-cache' }).end(JSON.stringify(obj));

function shutdown() {
  server.close();
  for (const cl of clients) cl.res.destroy();
  clients.clear();
  setTimeout(() => process.exit(0), 50);
}

function route(req, res) {
  let url;
  try { url = new URL(req.url, `http://${HOST}:${PORT}`); } catch { res.writeHead(400).end(); return; }

  if (req.method === 'POST' && (url.pathname === '/hook' || url.pathname === '/shutdown')) {
    // Only the local hook script posts here; refuse anything a web page sends.
    if (req.headers.origin) { res.writeHead(403).end(); return; }
    let body = '', size = 0;
    req.setEncoding('utf8'); // a character split across chunks must not be mangled
    req.on('error', () => {});
    req.on('data', d => {
      size += Buffer.byteLength(d);
      // Too big: keep reading and discarding so the client still gets its 413, but not forever.
      if (size > MAX_BODY) { body = ''; if (size > 64e6) req.destroy(); return; }
      body += d;
    });
    req.on('end', () => {
      // The header tells the hook it reached a kitchen, not some other program on the port.
      if (size > MAX_BODY) { res.writeHead(413, KITCHEN).end(); return; }
      if (url.pathname === '/shutdown') { res.writeHead(204, KITCHEN).end(); shutdown(); return; }
      lastEventAt = Date.now();
      try { handle(JSON.parse(body)); } catch (e) { if (!(e instanceof SyntaxError)) console.error(e); }
      res.writeHead(204, KITCHEN).end();
    });
    return;
  }

  if (req.method !== 'GET') { res.writeHead(405).end(); return; }
  // A rebinding page reaches us under its own hostname; only answer to ours.
  if (!HOSTS.has(String(req.headers.host).toLowerCase())) { res.writeHead(403).end(); return; }

  if (url.pathname === '/events') {
    // ?session=<id> watches that session; unknown pins the most recent one; none follows whichever is most recent.
    const want = url.searchParams.get('session');
    const latest = byRecent()[0];
    const cl = { res, sid: null, follow: !want, last: null };
    if (want) cl.sid = sessions.has(want) || !latest ? want : latest.id;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    clients.add(cl);
    send(cl, frameBody(cl, frameContext()));
    req.on('close', () => clients.delete(cl));
    return;
  }
  if (url.pathname === '/cook') {
    const c = sessions.get(url.searchParams.get('session'))?.cooks.get(url.searchParams.get('id'));
    if (!c) { json(res, 404, { error: 'no such cook' }); return; }
    json(res, 200, { id: c.id, prompt: c.prompt, report: c.report, log: c.log });
    return;
  }
  if (url.pathname === '/chef') {
    const s = sessions.get(url.searchParams.get('session'));
    if (!s) { json(res, 404, { error: 'no such session' }); return; }
    json(res, 200, { log: s.chefLog });
    return;
  }
  if (url.pathname === '/state') { json(res, 200, snapshot()); return; }
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': MIME['.json'], 'cache-control': 'no-cache', ...KITCHEN }).end(JSON.stringify({ ok: true, app: 'monkey-kitchen', version: VERSION, root: ROOT }));
    return;
  }

  let rel;
  try { rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1)); } catch { res.writeHead(400).end(); return; }
  const file = path.join(WEB, rel);
  if (!file.startsWith(WEB + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' }).end(data);
  });
}

const server = http.createServer((req, res) => {
  try { route(req, res); } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

process.on('uncaughtException', e => console.error('uncaught:', e));
process.on('unhandledRejection', e => console.error('unhandled rejection:', e));

server.on('error', err => {
  // Another copy already owns the port: that one is the kitchen, so bow out.
  if (err.code === 'EADDRINUSE') process.exit(0);
  console.error(err); process.exit(1);
});
server.listen(PORT, HOST, () => console.log(`Monkey Kitchen is open at http://localhost:${PORT}`));

// Settle stale cooks and chefs (MONKEY_KITCHEN_SWEEP_MS, default 20 s).
setInterval(sweep, SWEEP_MS).unref?.();
// Keep SSE connections alive with a fresh frame, and close up after a long quiet spell.
setInterval(() => {
  flush(true);
  if (Date.now() - lastEventAt > IDLE_EXIT_MS && clients.size === 0) process.exit(0);
}, KEEPALIVE_MS).unref?.();
