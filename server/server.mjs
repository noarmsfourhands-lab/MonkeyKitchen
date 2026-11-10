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

const BRIGADE = new Set(['sous-chef', 'frontend-cook', 'backend-cook', 'line-cook', 'taster', 'inspector', 'prep-cook', 'runner', 'dishwasher', 'scribe']);
const ROLE_NAME = {
  'head-chef': 'Head Chef', 'sous-chef': 'Sous Chef', 'frontend-cook': 'Pastry Chef', 'backend-cook': 'Grill Cook',
  'line-cook': 'Line Cook', taster: 'Taster', inspector: 'Health Inspector', 'prep-cook': 'Prep Cook',
  runner: 'Runner', dishwasher: 'Dishwasher', scribe: 'Menu Scribe', stagiaire: 'Stagiaire',
};

const sessions = new Map();
const clients = new Set();
let lastEventAt = Date.now();

const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const base = p => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';

// "monkey-kitchen:prep-cook" -> "prep-cook"; anything outside the brigade is a guest.
function roleOf(agentType = '') {
  const short = agentType.split(':').pop();
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
    default: return ['tool', tool?.startsWith('mcp__') ? `Using ${clip(tool.split('__').pop(), 28)}` : `Using ${clip(tool, 28)}`];
  }
}

function getSession(p) {
  let s = sessions.get(p.session_id);
  if (!s) {
    s = {
      id: p.session_id, cwd: p.cwd, project: base(p.cwd) || 'session', startedAt: Date.now(), lastEventAt: Date.now(),
      order: null, chef: { status: 'idle', activity: '' }, cooks: new Map(), pending: [], feed: [],
      dropped: 0, lastDrop: null, usage: null, meter: null, scanTimer: null,
    };
    sessions.set(s.id, s);
  }
  if (p.transcript_path && !s.meter) s.meter = new UsageMeter(p.transcript_path);
  if (p.cwd) { s.cwd = p.cwd; s.project = base(p.cwd) || s.project; }
  s.lastEventAt = Date.now();
  return s;
}

function say(s, who, text, fail = false) {
  s.feed.push({ t: Date.now(), who, text, fail });
  if (s.feed.length > 80) s.feed.splice(0, s.feed.length - 80);
}

function getCook(s, p) {
  let c = s.cooks.get(p.agent_id);
  if (!c) {
    c = { id: p.agent_id, agentType: p.agent_type || '', role: roleOf(p.agent_type), ticket: '', activity: '', kind: 'think', status: 'working', startedAt: Date.now(), endedAt: 0, tools: 0 };
    // Pick up the ticket the Head Chef wrote when calling the Agent tool.
    const i = s.pending.findIndex(t => roleOf(t.type) === c.role);
    if (i >= 0) c.ticket = s.pending.splice(i, 1)[0].ticket;
    s.cooks.set(c.id, c);
    say(s, c.role, c.ticket ? `picked up: ${c.ticket}` : 'clocked in');
  }
  return c;
}

function handle(p) {
  if (!p || !p.session_id || !p.hook_event_name) return;
  const s = getSession(p);
  const fromCook = Boolean(p.agent_id);
  const who = fromCook ? getCook(s, p).role : 'head-chef';

  switch (p.hook_event_name) {
    case 'SessionStart':
      say(s, 'head-chef', `opened the kitchen in ${s.project}`);
      break;

    case 'UserPromptSubmit':
      // New order: clear finished tickets off the rail.
      for (const [id, c] of s.cooks) if (c.status !== 'working') s.cooks.delete(id);
      s.order = { text: clip(p.prompt, 400), startedAt: Date.now(), status: 'cooking' };
      s.chef = { status: 'working', activity: 'Reading the order', kind: 'think' };
      say(s, 'head-chef', `new order: ${clip(p.prompt, 90)}`);
      break;

    case 'PreToolUse': {
      const [kind, what] = describe(p.tool_name, p.tool_input);
      if (fromCook) {
        const c = getCook(s, p);
        c.activity = what; c.kind = kind; c.tools++; c.status = 'working';
      } else {
        s.chef = { status: 'working', activity: what, kind };
        if (s.order && s.order.status !== 'cooking') s.order.status = 'cooking';
      }
      if (p.tool_name === 'Agent' || p.tool_name === 'Task') {
        const type = p.tool_input?.subagent_type || '';
        const ticket = clip(p.tool_input?.description || p.tool_input?.prompt, 80);
        // The cook may already have clocked in if events arrived out of order.
        const waiting = [...s.cooks.values()].find(c => !c.ticket && c.status === 'working' && c.role === roleOf(type) && Date.now() - c.startedAt < 5000);
        if (waiting) waiting.ticket = ticket; else s.pending.push({ type, ticket, at: Date.now() });
        say(s, who, `→ ${ROLE_NAME[roleOf(type)]}: ${ticket}`);
      }
      break;
    }

    case 'PostToolUse':
      break;

    case 'PostToolUseFailure':
      s.dropped++;
      s.lastDrop = { by: p.agent_id || 'head-chef', n: s.dropped };
      say(s, who, `dropped a plate (${p.tool_name})`, true);
      if (p.tool_name === 'Agent' || p.tool_name === 'Task') {
        const role = roleOf(p.tool_input?.subagent_type);
        const c = [...s.cooks.values()].reverse().find(x => x.role === role && x.status === 'working');
        if (c) { c.status = 'failed'; c.endedAt = Date.now(); }
      }
      break;

    case 'SubagentStart':
      getCook(s, p);
      break;

    case 'SubagentStop': {
      const c = getCook(s, p);
      if (c.status === 'working') { c.status = 'done'; c.endedAt = Date.now(); }
      c.activity = '';
      say(s, c.role, `order up${c.tools ? ` (${c.tools} steps)` : ''}`);
      break;
    }

    case 'Notification':
      if (!fromCook && /permission|idle|elicitation/i.test(p.notification_type || '')) {
        s.chef = { status: 'waiting', activity: `🛎️ ${clip(p.message || 'Needs you', 40)}` };
      }
      break;

    case 'Stop':
      s.chef = { status: 'idle', activity: '' };
      if (s.order) s.order.status = 'served';
      say(s, 'head-chef', 'service! order served');
      break;

    case 'SessionEnd':
      s.chef = { status: 'idle', activity: '' };
      for (const c of s.cooks.values()) if (c.status === 'working') { c.status = 'done'; c.endedAt = Date.now(); }
      say(s, 'head-chef', 'closed the kitchen');
      break;
  }

  s.pending = s.pending.filter(t => Date.now() - t.at < 60000);
  if (s.cooks.size > 60) for (const [id, c] of s.cooks) { if (s.cooks.size <= 40) break; if (c.status !== 'working') s.cooks.delete(id); }
  scheduleScan(s, p.hook_event_name === 'Stop' || p.hook_event_name === 'SubagentStop' ? 300 : 2500);
  broadcast();
}

function scheduleScan(s, delay) {
  if (!s.meter || s.scanTimer) return;
  s.scanTimer = setTimeout(async () => {
    s.scanTimer = null;
    try { const u = await s.meter.scan(); if (u) { s.usage = u; broadcast(); } } catch { /* transcript not readable yet */ }
  }, delay);
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

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  if (req.method === 'POST' && url.pathname === '/hook') {
    // Only the local hook script posts here; refuse anything a web page sends.
    if (req.headers.origin) { res.writeHead(403).end(); return; }
    let body = '';
    req.on('data', d => { body += d; if (body.length > 5e6) req.destroy(); });
    req.on('end', () => {
      lastEventAt = Date.now();
      try { handle(JSON.parse(body)); } catch { /* ignore malformed payloads */ }
      res.writeHead(204).end();
    });
    return;
  }

  if (req.method !== 'GET') { res.writeHead(405).end(); return; }

  if (url.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (url.pathname === '/state') { res.writeHead(200, { 'content-type': MIME['.json'] }).end(JSON.stringify(snapshot())); return; }
  if (url.pathname === '/health') { res.writeHead(200, { 'content-type': MIME['.json'] }).end('{"ok":true,"app":"monkey-kitchen"}'); return; }

  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const file = path.join(WEB, rel);
  if (!file.startsWith(WEB + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' }).end(data);
  });
});

server.on('error', err => {
  // Another copy already owns the port: that one is the kitchen, so bow out.
  if (err.code === 'EADDRINUSE') process.exit(0);
  console.error(err); process.exit(1);
});
server.listen(PORT, HOST, () => console.log(`Monkey Kitchen is open at http://localhost:${PORT}`));

// Keep SSE connections alive, refresh "recently finished" states, and close up after a long quiet spell.
setInterval(() => {
  for (const res of clients) res.write(': ping\n\n');
  if (Date.now() - lastEventAt > IDLE_EXIT_MS && clients.size === 0) process.exit(0);
}, 20000).unref?.();
