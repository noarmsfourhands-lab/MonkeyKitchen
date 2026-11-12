#!/usr/bin/env node
// Relays one Claude Code hook payload (JSON on stdin) to the kitchen server,
// starting the server if it isn't running. Never fails the hook: a kitchen
// that is closed must not get in the way of the session.
//
//   node hook.mjs            relay only
//   node hook.mjs --context  relay, then print the brigade rules for SessionStart;
//                            at startup also replaces a running server from an older version or a deleted folder

// The event time is when this process started, before module loading: async hooks can reach the server out of order.
const TS = Math.round(performance.timeOrigin) || Date.now();

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveToken, pageKey, healthProof, sameToken } from '../server/token.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The master token goes only to a server that has proved it holds the same one (see probe()); the browser link
// carries the read-only page key derived from it.
const TOKEN = (() => { try { return resolveToken(); } catch { return null; } })();
const PAGE = pageKey(TOKEN);
const FIRST_KEYED = '0.3.0'; // kitchens older than this have no keys: they get no token, and no payload
let proven = false; // a server proved our key at some point in this run
const PORT = Number(process.env.MONKEY_KITCHEN_PORT) || 4747;
const BUDGET_MS = 2800; // reaching or starting the server may never hold the session up longer than this
const LOCK = path.join(os.tmpdir(), `monkey-kitchen-${PORT}.lock`);
const LOCK_MS = 20000;
const CONTEXT = process.argv.includes('--context');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let t0 = Date.now();
const left = () => BUDGET_MS - (Date.now() - t0);

function version() {
  try { return String(JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version || ''); } catch { return ''; }
}

// Only what the server reads goes over the wire: tool responses and Write/Edit inputs can hold whole files.
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
function val(v, n) {
  if (typeof v === 'string') return cut(v, n);
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (v && typeof v === 'object' && typeof v.level === 'string') return { level: cut(v.level, 40) };
  return undefined;
}
function pick(src, fields) {
  const out = {};
  for (const [k, n] of Object.entries(fields)) { const v = val(src[k], n); if (v !== undefined) out[k] = v; }
  return out;
}
const TOP = {
  session_id: 200, transcript_path: 4096, cwd: 4096, hook_event_name: 100, agent_id: 200, agent_type: 200, agent_transcript_path: 4096,
  tool_name: 200, tool_use_id: 200, source: 100, model: 200, effort: 40, prompt: 4000, notification_type: 100, message: 500, last_assistant_message: 4000,
};
const INPUT = { file_path: 1000, notebook_path: 1000, pattern: 500, command: 1000, description: 500, url: 2000, query: 500, subagent_type: 200, prompt: 4000, model: 200, effort: 40 };
const RESPONSE = { agentId: 200, status: 100, resolvedModel: 200 };
function slim(p) {
  const out = pick(typeof p.prompt === 'string' ? { ...p, prompt: stripReminders(p.prompt) } : p, TOP);
  if (p.tool_input && typeof p.tool_input === 'object') out.tool_input = pick(p.tool_input, INPUT);
  // The server reads a response only for Agent calls, so only theirs is worth parsing when it comes as a string.
  let r = p.tool_response;
  if (typeof r === 'string') {
    r = (p.tool_name === 'Agent' || p.tool_name === 'Task') && r.length < 5e7 && r.trimStart().startsWith('{') ? (() => { try { return JSON.parse(r); } catch { return null; } })() : null;
  }
  if (r && typeof r === 'object' && !Array.isArray(r)) { const o = pick(r, RESPONSE); if (Object.keys(o).length) out.tool_response = o; }
  return out;
}

// Claude Code can put <system-reminder> blocks before the user's own words; drop them so the clip keeps the real text.
const REMINDER = /^<system-reminder(?:\s[^>]*)?>[\s\S]*?<\/system-reminder>/;
function stripReminders(t) { t = t.trimStart(); let m; while ((m = REMINDER.exec(t))) t = t.slice(m[0].length).trimStart(); return t; }

// Reads at most `max` characters of the answer: enough to recognise who is talking.
// `withToken` adds the master token: only for a server that has just proved it holds it.
function request(method, urlPath, body, timeout, max = 1e5, withToken = false) {
  const headers = body == null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) };
  if (withToken && TOKEN) headers['x-mk-token'] = TOKEN;
  return new Promise(resolve => {
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: urlPath, method, timeout, agent: false, headers,
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      const done = () => resolve({ r: 'ok', status: res.statusCode, kitchen: res.headers['x-monkey-kitchen'] === '1', proof: res.headers['x-mk-proof'], data });
      res.on('data', d => { data += d; if (data.length >= max) { done(); res.destroy(); } });
      res.on('end', done);
      res.on('error', done);
    });
    req.on('error', e => resolve({ r: e.code === 'ECONNREFUSED' ? 'refused' : 'fail' }));
    req.on('timeout', () => { req.destroy(); resolve({ r: 'fail' }); });
    req.end(body ?? undefined);
  });
}
const wait = () => Math.max(50, Math.min(600, left()));
// Posted only after a proof. 'locked' if it then refuses the key after all (its key file changed in between).
const post = async body => { const a = await request('POST', '/hook', body, wait(), 1e5, true); return a.r !== 'ok' ? a.r : !a.kitchen ? 'foreign' : a.status === 401 ? 'locked' : 'ok'; };

// Who owns the port, asked without sending the payload or the token:
//   'kitchen' our kitchen: its /health answered our random challenge with HMAC(token, 'health:' + challenge)
//   'old'     a kitchen from before keys (older than FIRST_KEYED): replaced at startup through its open /shutdown
//   'locked'  a kitchen that cannot prove our key (another key file, or one we could not read)
//   'legacy'  a kitchen from before /health, which cannot be told to leave
//   'foreign' another program; 'refused' nobody; 'fail' no answer
async function probe() {
  const c = crypto.randomBytes(16).toString('hex');
  const h = await request('GET', `/health?c=${c}`, null, wait());
  if (h.r !== 'ok') return { kind: h.r };
  let info = null;
  try { info = JSON.parse(h.data); } catch { /* not a kitchen's health */ }
  if (h.kitchen || (h.status === 200 && info?.app === 'monkey-kitchen')) {
    if (TOKEN && sameToken(h.proof, healthProof(TOKEN, c))) { proven = true; return { kind: 'kitchen', info }; }
    if (info?.app === 'monkey-kitchen' && olderVersion(info.version, FIRST_KEYED)) return { kind: 'old', info };
    return { kind: 'locked' };
  }
  const st = await request('GET', '/state', null, wait(), 200);
  if (st.r === 'ok' && st.status === 200 && /^\{"now":\d+,"sessions":\[/.test(st.data)) return { kind: 'legacy' };
  return { kind: 'foreign' };
}

// One hook starts the server; the rest wait for it. A lock older than LOCK_MS is from a start that died.
function takeLock() {
  for (let i = 0; i < 2; i++) {
    try { fs.closeSync(fs.openSync(LOCK, 'wx')); return true; } catch (e) {
      if (e.code !== 'EEXIST') return true; // no usable temp folder: start without a lock
      try { if (Date.now() - fs.statSync(LOCK).mtimeMs < LOCK_MS) return false; fs.unlinkSync(LOCK); } catch { /* raced: retry once */ }
    }
  }
  return false;
}
const dropLock = () => { try { fs.unlinkSync(LOCK); } catch { /* gone */ } };

function startServer() {
  // cwd is the plugin root: on Windows a process locks its working folder, and the user's project must stay free.
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'server.mjs')], {
    cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.on('error', () => {});
  child.unref();
}

// Dotted versions compared numerically: "0.10.0" is newer than "0.9.3".
function olderVersion(a, b) {
  const x = String(a ?? '').split('.').map(n => parseInt(n, 10) || 0), y = String(b ?? '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0);
  return false;
}
// Only an older release, or one whose folder is gone, gives way: two live installs must not keep killing each other.
const outdated = info => olderVersion(info?.version, version()) || (typeof info?.root === 'string' && !fs.existsSync(info.root));

// Ask a running kitchen to leave and wait until the port is free; false when it stays. The token goes only to our
// own (proven) kitchen; an old keyless one is asked without it.
async function retire(withToken) {
  const bye = await request('POST', '/shutdown', '{}', wait(), 1e5, withToken);
  if (bye.r !== 'ok' || bye.status >= 300) return false;
  while (left() > 600) { if ((await request('GET', '/health', null, 300)).r === 'refused') return true; await sleep(100); }
  return false;
}

// The payload (and the token) go only to our own kitchen. Returns 'ok', 'legacy', 'locked', 'foreign', 'refused'
// or 'fail'. At startup an outdated kitchen is replaced: ours with the token, an old keyless one without it.
async function relay(body, source) {
  t0 = Date.now();
  const startup = CONTEXT && source === 'startup';
  let p = await probe();
  if (p.kind === 'old') p = startup && await retire(false) ? { kind: 'refused' } : { kind: 'legacy' };
  else if (p.kind === 'kitchen' && startup && outdated(p.info) && await retire(true)) p = { kind: 'refused' };
  if (p.kind === 'kitchen') return post(body);
  // Only a refused connection means no server is running; a timeout or reset must not spawn another.
  if (p.kind !== 'refused') return p.kind;
  const mine = takeLock();
  if (mine) startServer();
  let r = 'refused';
  while (left() > 250) {
    await sleep(200);
    const q = await probe();
    if (q.kind === 'kitchen') { r = await post(body); if (r === 'ok' || r === 'locked') { if (mine) dropLock(); return r; } }
    else if (q.kind === 'old') return 'legacy';
    else if (q.kind !== 'refused' && q.kind !== 'fail') return q.kind;
  }
  return r;
}

setTimeout(() => process.exit(0), BUDGET_MS + 1500).unref(); // last resort if stdin or the network hangs

let out = '', status = '';
try {
  let raw = '';
  process.stdin.setEncoding('utf8'); // a character split across chunks must not be mangled
  for await (const chunk of process.stdin) raw += chunk;

  let payload = null;
  try { payload = JSON.parse(raw); } catch { /* not JSON: relay nothing */ }
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const body = slim(payload);
    body._mk = { id: crypto.randomUUID(), ts: TS, projectDir: process.env.CLAUDE_PROJECT_DIR || null };
    // Without a key no kitchen can be ours: nothing is sent and none is started.
    status = TOKEN ? await relay(JSON.stringify(body), payload.source) : 'nokey';
  } else if (!TOKEN) status = 'nokey';

  if (CONTEXT) {
    // Routing off keeps the view: the session still needs its link, just not the rules.
    const rules = process.env.MONKEY_KITCHEN_ROUTING === 'off'
      ? 'The Monkey Kitchen plugin is showing this session in its kitchen view. Its routing rules are switched off here, so work as you normally would.'
      : fs.readFileSync(path.join(ROOT, 'brigade', 'head-chef.md'), 'utf8');
    // The link carries the read-only page key, never the master token, and is given only for a kitchen that proved
    // it holds our key (now, or earlier in this run when the last attempt then failed).
    const link = `The live kitchen view is at http://localhost:${PORT}/?k=${PAGE} (this link unlocks the page in your browser; share it only with the user).`;
    const where = status === 'nokey'
      ? 'The kitchen view is unavailable: no key file could be created in your home folder.'
      : status === 'foreign'
        ? `The kitchen view is off: port ${PORT} is used by another program. Set MONKEY_KITCHEN_PORT to a free port.`
        : status === 'legacy'
          ? `An older Monkey Kitchen server is still running on port ${PORT}. Stop it once (close the process listening on that port); the next session starts the new one.`
          : status === 'locked'
            ? `The Monkey Kitchen server on port ${PORT} uses a different key, so this session cannot reach it. Stop it once (close the process listening on that port); the next session starts a new one.`
            : status === 'ok' || proven
              ? link
              : `The kitchen view could not be started on port ${PORT}.`;
    out = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: `${rules}\n${where}`,
      },
    });
  }
} catch { /* stay silent */ }
// Exit only once stdout has flushed: process.exit() right after a write can truncate piped output.
process.stdout.on('error', () => process.exit(0)); // a closed pipe (EPIPE) must not fail the hook
if (out) process.stdout.write(out, () => process.exit(0)); else process.exit(0);
