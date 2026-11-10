// Monkey Kitchen server. No dependencies.
//   POST /hook    raw Claude Code hook payloads (sent by scripts/hook.mjs)
//   GET  /events  server-sent events: a full state snapshot on every change
//   GET  /state   the same snapshot as JSON
//   GET  /        the kitchen page

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UsageMeter } from './usage.mjs';

const PORT = Number(process.env.MONKEY_KITCHEN_PORT) || 4747;
const HOST = '127.0.0.1';
const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const IDLE_EXIT_MS = 12 * 60 * 60 * 1000;
const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
const ENDED_KEEP_MS = 30 * 60 * 1000;
const STALE_MS = Number(process.env.MONKEY_KITCHEN_STALE_MS) || 15 * 60 * 1000;

const BRIGADE = new Set(['sous-chef', 'frontend-cook', 'backend-cook', 'line-cook', 'taster', 'inspector', 'prep-cook', 'runner', 'dishwasher', 'scribe']);
const ROLE_NAME = {
  'head-chef': 'Head Chef', 'sous-chef': 'Sous Chef', 'frontend-cook': 'Pastry Chef', 'backend-cook': 'Grill Cook',
  'line-cook': 'Line Cook', taster: 'Taster', inspector: 'Health Inspector', 'prep-cook': 'Prep Cook',
  runner: 'Runner', dishwasher: 'Dishwasher', scribe: 'Menu Scribe', stagiaire: 'Stagiaire',
};
// Events that belong to one cook; a cook that isn't on the rail yet may only be created by the first two.
const COOK_EVENTS = new Set(['SubagentStart', 'SubagentStop', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure']);
const CREATES_COOK = new Set(['SubagentStart', 'PreToolUse']);

const sessions = new Map();
const clients = new Set();
const seen = new Set(); // recent _mk.ids, to drop duplicate deliveries
let lastEventAt = Date.now();

const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const base = p => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';
const isAgentTool = t => t === 'Agent' || t === 'Task';
// Keep a Map or Set at or under max entries, dropping the oldest.
const trim = (coll, max) => { while (coll.size > max) coll.delete(coll.keys().next().value); };

// "monkey-kitchen:prep-cook" -> "prep-cook"; anything outside the brigade is a guest.
function roleOf(agentType) {
  const short = typeof agentType === 'string' ? agentType.split(':').pop() : '';
  return BRIGADE.has(short) ? short : 'stagiaire';
}

function describe(tool, input = {}) {
  switch (tool) {
    case 'Read': return ['read', `Reading ${base(input.file_path)}`];
    case 'Edit': case 'Write': case 'NotebookEdit': return ['write', `Writing ${base(input.file_path || input.notebook_path)}`];
    case 'Grep': return ['search', `Searching for "${clip(input.pattern, 24)}"`];
    case 'Glob': return ['search', `Looking for ${clip(input.pattern, 28)}`];
    case 'Bash': case 'PowerShell': return ['run', `Running: ${clip(input.description || input.command, 36)}`];
    case 'WebFetch': { try { return ['web', `Fetching ${new URL(input.url).host}`]; } catch { return ['web', 'Fetching a page']; } }
    case 'WebSearch': return ['web', `Looking up "${clip(input.query, 26)}"`];
    case 'Agent': case 'Task': return ['delegate', `Calling the ${ROLE_NAME[roleOf(input.subagent_type)]}`];
    default: return ['tool', typeof tool === 'string' && tool.startsWith('mcp__') ? `Using ${clip(tool.split('__').pop(), 28)}` : `Using ${clip(tool, 28)}`];
  }
}

function getSession(p) {
  let s = sessions.get(p.session_id);
  if (!s) {
    s = {
      id: p.session_id, cwd: '', project: 'session', fixedProject: false, startedAt: Date.now(), lastEventAt: Date.now(), mainAt: Date.now(),
      order: null, chef: { status: 'idle', activity: '' }, cooks: new Map(), pending: [], feed: [],
      calls: new Map(), known: new Map(), early: new Map(), ended: new Set(), promptAt: 0, lastStopAt: 0, endTimer: null,
      dropped: 0, lastDrop: null, usage: null, meter: null, scans: new Map(),
    };
    sessions.set(s.id, s);
  }
  if (p.transcript_path && !s.meter) s.meter = new UsageMeter(p.transcript_path);
  // The project is the dir Claude Code was opened in; cwd drifts as the work moves, so only the first one counts.
  const dir = p._mk?.projectDir;
  if (dir && base(dir)) { s.project = base(dir); s.fixedProject = true; }
  if (p.cwd && !s.cwd) { s.cwd = p.cwd; if (!s.fixedProject) s.project = base(p.cwd) || s.project; }
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

function say(s, who, text, fail = false) {
  s.feed.push({ t: Date.now(), who, text, fail });
  if (s.feed.length > 80) s.feed.splice(0, s.feed.length - 80);
}

function finish(s, c, status) {
  c.status = status; c.endedAt = Date.now();
  s.ended.add(c.id); trim(s.ended, 1000);
}

function getCook(s, p, create) {
  let c = s.cooks.get(p.agent_id);
  if (c || !create || s.ended.has(p.agent_id)) return c || null;
  c = {
    id: p.agent_id, agentType: p.agent_type || '', role: roleOf(p.agent_type), ticket: '', activity: '', kind: 'think', status: 'working',
    startedAt: Date.now(), endedAt: 0, lastEventAt: Date.now(), tools: 0, model: '', tier: '', guessCall: null,
  };
  const known = s.known.get(c.id);
  if (known) {
    // The Agent call's own response already named this cook.
    c.ticket = known.ticket; c.model = known.model; s.known.delete(c.id);
  } else {
    // Guess the ticket the Head Chef wrote: oldest unclaimed call for this role. PostToolUse corrects it.
    const i = s.pending.findIndex(t => roleOf(t.type) === c.role);
    if (i >= 0) { const t = s.pending.splice(i, 1)[0]; c.ticket = t.ticket; c.guessCall = t.id; }
  }
  const a = s.usage?.agents?.[c.id];
  if (a) { c.tier = a.tier; c.model ||= a.model; }
  s.cooks.set(c.id, c);
  say(s, c.role, c.ticket ? `picked up: ${c.ticket}` : 'clocked in');
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
  for (const o of s.cooks.values()) if (o !== c && o.guessCall === id) { o.ticket = ''; o.guessCall = null; }
  if (!c) { s.known.set(agentId, { ticket: call.ticket, model }); trim(s.known, 200); return; }
  c.ticket = call.ticket; c.guessCall = null;
  if (model) c.model = model;
}

function handle(p) {
  if (!p || !p.session_id || !p.hook_event_name) return;
  const mid = p._mk?.id;
  if (mid) { if (seen.has(mid)) return; seen.add(mid); trim(seen, 2000); }
  const at = Number(p._mk?.ts) || Date.now();
  const ev = p.hook_event_name;
  const s = getSession(p);
  const fromCook = Boolean(p.agent_id);

  let c = null;
  if (fromCook && COOK_EVENTS.has(ev)) {
    c = getCook(s, p, CREATES_COOK.has(ev));
    if (!c) { if (ev === 'SubagentStop') { s.ended.add(p.agent_id); trim(s.ended, 1000); } return; }
    // A cook the sweep gave up on was only quiet: any event from it brings it back.
    if (c.stale) { c.status = 'working'; c.stale = false; c.endedAt = 0; }
    // A finished cook stays finished: late async events must not bring it back.
    if (c.status !== 'working' && ev !== 'PostToolUseFailure') return;
    if (c.status === 'working') c.lastEventAt = Date.now();
  } else if (!fromCook) s.mainAt = Date.now();
  const who = c ? c.role : 'head-chef';

  switch (ev) {
    case 'SessionStart':
      clearTimeout(s.endTimer);
      say(s, 'head-chef', `opened the kitchen in ${s.project}`);
      break;

    case 'UserPromptSubmit': {
      clearTimeout(s.endTimer);
      // New order: clear finished tickets off the rail.
      for (const [id, k] of s.cooks) if (k.status !== 'working') s.cooks.delete(id);
      s.promptAt = Math.max(s.promptAt, at);
      // The Stop of this short turn may have been delivered first: then the order is already served.
      const served = at < s.lastStopAt;
      s.order = { text: clip(p.prompt, 400), startedAt: Date.now(), status: served ? 'served' : 'cooking' };
      if (!served) s.chef = { status: 'working', activity: 'Reading the order', kind: 'think' };
      say(s, 'head-chef', `new order: ${clip(p.prompt, 90)}`);
      break;
    }

    case 'PreToolUse': {
      const [kind, what] = describe(p.tool_name, p.tool_input);
      if (c) {
        c.activity = what; c.kind = kind; c.tools++;
      } else if (at >= s.lastStopAt) {
        s.chef = { status: 'working', activity: what, kind };
        if (s.order && s.order.status !== 'cooking') s.order.status = 'cooking';
      }
      if (isAgentTool(p.tool_name)) {
        const type = p.tool_input?.subagent_type || '';
        const ticket = clip(p.tool_input?.description || p.tool_input?.prompt, 80);
        const id = p.tool_use_id || null;
        if (id) { s.calls.set(id, { type, ticket, model: p.tool_input?.model || '' }); trim(s.calls, 200); }
        // The cook may already have clocked in if events arrived out of order.
        const early = id && s.early.get(id);
        if (early) { s.early.delete(id); applyPair(s, id, s.calls.get(id), early.agentId, early.model); } else {
          const waiting = [...s.cooks.values()].find(k => !k.ticket && k.status === 'working' && k.role === roleOf(type) && Date.now() - k.startedAt < 5000);
          if (waiting) { waiting.ticket = ticket; waiting.guessCall = id; } else s.pending.push({ id, type, ticket, at: Date.now() });
        }
        say(s, who, `→ ${ROLE_NAME[roleOf(type)]}: ${ticket}`);
      }
      break;
    }

    case 'PostToolUse':
      if (!c && s.chef.status === 'waiting' && at >= s.lastStopAt) s.chef = { ...s.chef, status: 'working' };
      if (!c && isAgentTool(p.tool_name)) pairCook(s, p);
      break;

    case 'PostToolUseFailure':
      s.dropped++;
      s.lastDrop = { by: p.agent_id || 'head-chef', n: s.dropped };
      say(s, who, `dropped a plate (${p.tool_name})`, true);
      if (!c && isAgentTool(p.tool_name)) {
        s.pending = s.pending.filter(t => t.id !== p.tool_use_id);
        // Only a cook we can name can be failed (by the paired call, else the response); guessing by role hit the wrong plate.
        const k = s.cooks.get(s.calls.get(p.tool_use_id)?.agentId || s.early.get(p.tool_use_id)?.agentId || asObject(p.tool_response).agentId);
        if (k && k.status === 'working') finish(s, k, 'failed');
      }
      break;

    case 'SubagentStart':
      break;

    case 'SubagentStop':
      finish(s, c, 'done');
      c.activity = '';
      say(s, c.role, `order up${c.tools ? ` (${c.tools} steps)` : ''}`);
      break;

    case 'Notification':
      if (!fromCook && /permission|idle|elicitation/i.test(p.notification_type || '')) {
        s.chef = { status: 'waiting', activity: `🛎️ ${clip(p.message || 'Needs you', 40)}` };
      }
      break;

    case 'Stop':
      if (at < s.promptAt) break; // belongs to an order that a newer prompt already replaced
      s.lastStopAt = Math.max(s.lastStopAt, at);
      s.chef = { status: 'idle', activity: '' };
      if (s.order) s.order.status = 'served';
      say(s, 'head-chef', 'service! order served');
      break;

    case 'SessionEnd':
      s.chef = { status: 'idle', activity: '' };
      s.lastStopAt = Math.max(s.lastStopAt, at);
      if (s.order) s.order.status = 'served';
      for (const k of s.cooks.values()) if (k.status === 'working') finish(s, k, 'done');
      say(s, 'head-chef', 'closed the kitchen');
      clearTimeout(s.endTimer);
      s.endTimer = setTimeout(() => evict(s), ENDED_KEEP_MS);
      s.endTimer.unref?.();
      break;
  }

  s.pending = s.pending.filter(t => Date.now() - t.at < 60000);
  if (s.cooks.size > 60) for (const [id, k] of s.cooks) { if (s.cooks.size <= 40) break; if (k.status !== 'working') s.cooks.delete(id); }
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
    // Quiet is not finished (a slow permission prompt, one long step): mark it stale, and any later event revives it.
    for (const c of s.cooks.values()) if (c.status === 'working' && now - c.lastEventAt > STALE_MS) { c.status = 'done'; c.stale = true; c.endedAt = now; changed = true; }
    const busy = [...s.cooks.values()].some(c => c.status === 'working');
    if (s.chef.status === 'working' && !busy && now - s.mainAt > STALE_MS) { s.chef = { status: 'idle', activity: '' }; changed = true; }
  }
  if (changed) broadcast();
}

function snapshot() {
  const list = [...sessions.values()].sort((a, b) => b.lastEventAt - a.lastEventAt).slice(0, 12).map(s => ({
    id: s.id, project: s.project, order: s.order, chef: s.chef,
    cooks: [...s.cooks.values()], feed: s.feed.slice(-60), dropped: s.dropped, lastDrop: s.lastDrop, usage: s.usage,
  }));
  return { now: Date.now(), sessions: list };
}

let pendingBroadcast = null;
function broadcast() {
  if (pendingBroadcast) return;
  pendingBroadcast = setTimeout(() => {
    pendingBroadcast = null;
    const msg = `data: ${JSON.stringify(snapshot())}\n\n`;
    for (const res of clients) res.write(msg);
  }, 80);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const HOSTS = new Set([`${HOST}:${PORT}`, `localhost:${PORT}`]);

function route(req, res) {
  let url;
  try { url = new URL(req.url, `http://${HOST}:${PORT}`); } catch { res.writeHead(400).end(); return; }

  if (req.method === 'POST' && url.pathname === '/hook') {
    // Only the local hook script posts here; refuse anything a web page sends.
    if (req.headers.origin) { res.writeHead(403).end(); return; }
    let body = '', big = false;
    req.on('data', d => {
      if (big) return;
      body += d;
      if (body.length > 5e6) { big = true; body = ''; req.pause(); res.writeHead(413, { connection: 'close' }).end(); }
    });
    req.on('end', () => {
      if (big) return;
      lastEventAt = Date.now();
      try { handle(JSON.parse(body)); } catch (e) { if (!(e instanceof SyntaxError)) console.error(e); }
      res.writeHead(204).end();
    });
    return;
  }

  if (req.method !== 'GET') { res.writeHead(405).end(); return; }
  // A rebinding page reaches us under its own hostname; only answer to ours.
  if (!HOSTS.has(String(req.headers.host).toLowerCase())) { res.writeHead(403).end(); return; }

  if (url.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (url.pathname === '/state') { res.writeHead(200, { 'content-type': MIME['.json'] }).end(JSON.stringify(snapshot())); return; }
  if (url.pathname === '/health') { res.writeHead(200, { 'content-type': MIME['.json'] }).end('{"ok":true,"app":"monkey-kitchen"}'); return; }

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

// Keep SSE connections alive, settle stale cooks, and close up after a long quiet spell.
setInterval(() => {
  for (const res of clients) res.write(': ping\n\n');
  sweep();
  if (Date.now() - lastEventAt > IDLE_EXIT_MS && clients.size === 0) process.exit(0);
}, 20000).unref?.();
