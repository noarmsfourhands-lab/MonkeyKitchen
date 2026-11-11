// Shared test helpers: start a kitchen server on a random high port as a child
// process, talk to it over HTTP, and play hook events at it. Node built-ins only.

import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SERVER = path.join(ROOT, 'server', 'server.mjs');
export const HOOK = path.join(ROOT, 'scripts', 'hook.mjs');
export const DEMO = path.join(ROOT, 'scripts', 'demo.mjs');
export const PID_PRELOAD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pid-preload.mjs');

const LIVE_PORT = 4747; // the user's real kitchen: never touched
const sleep = ms => new Promise(r => setTimeout(r, ms));
export { sleep };

// Every child this process starts, so a crash still cleans up.
const children = new Set();
process.on('exit', () => { for (const c of children) { try { c.kill(); } catch { /* gone */ } } });

export function randomPort() {
  let p;
  do p = 20000 + Math.floor(Math.random() * 40000); while (p === LIVE_PORT);
  return p;
}

export function portFree(port) {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

export async function freePort() {
  for (let i = 0; i < 50; i++) {
    const p = randomPort();
    if (await portFree(p)) return p;
  }
  throw new Error('no free port found');
}

// The test runner's and the user's environment must not leak into the children.
export function childEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of ['CLAUDE_PROJECT_DIR', 'MONKEY_KITCHEN_PORT', 'MONKEY_KITCHEN_STALE_MS', 'MONKEY_KITCHEN_SWEEP_MS', 'MONKEY_KITCHEN_ROUTING', 'MK_TEST_PIDFILE', 'MK_TEST_CWDFILE', 'NODE_TEST_CONTEXT', 'NODE_OPTIONS']) delete env[k];
  return { ...env, ...extra };
}

export function request(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers, agent: false }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('request timeout')));
    req.end(body);
  });
}

function waitExit(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    const t = setTimeout(() => resolve(false), ms);
    child.once('exit', () => { clearTimeout(t); resolve(true); });
  });
}

export async function killChild(child) {
  if (!child) return;
  if (child.exitCode === null && child.signalCode === null) {
    child.kill();
    if (!(await waitExit(child, 3000))) { try { child.kill('SIGKILL'); } catch { /* gone */ } await waitExit(child, 2000); }
  }
  children.delete(child);
}

// Start `node server/server.mjs` on a random free high port; retry if the port is taken.
// `server` lets a test run a copy of the server folder (e.g. with a broken pricing.json).
export async function startKitchen(env = {}, { server = SERVER } = {}) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const port = await freePort();
    const child = spawn(process.execPath, [server], {
      cwd: path.dirname(path.dirname(server)), env: childEnv({ MONKEY_KITCHEN_PORT: String(port), ...env }), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    children.add(child);
    let out = '', err = '';
    child.stderr.on('data', d => { err += d; });
    const ok = await new Promise(resolve => {
      const t = setTimeout(() => resolve(false), 8000);
      child.stdout.on('data', d => { out += d; if (out.includes(`http://localhost:${port}`)) { clearTimeout(t); resolve(true); } });
      child.once('exit', () => { clearTimeout(t); resolve(false); });
    });
    if (!ok) { await killChild(child); continue; }
    return makeKitchen(port, child, () => err);
  }
  throw new Error('could not start a kitchen server');
}

function makeKitchen(port, child, stderr) {
  const k = {
    port, child, stderr,
    stop: () => killChild(child),
    request: opts => request(port, opts),
    async post(payload) {
      const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
      return request(port, { method: 'POST', path: '/hook', headers: { 'content-type': 'application/json' }, body });
    },
    async state() {
      const r = await request(port, { path: '/state' });
      if (r.status !== 200) throw new Error(`/state returned ${r.status}`);
      return JSON.parse(r.body);
    },
    async session(id) { return (await k.state()).sessions.find(s => s.id === id) || null; },
    async cook(sid, agentId) { return (await k.session(sid))?.cooks.find(c => c.id === agentId) || null; },
    async health() { return (await request(port, { path: '/health' })).status; },
    // Poll until fn(state) returns something truthy.
    async until(fn, ms = 5000, every = 100) {
      const end = Date.now() + ms;
      let last;
      while (Date.now() < end) { last = await fn(await k.state()); if (last) return last; await sleep(every); }
      return last;
    },
    // A scripted session: each event gets a unique _mk.id and a monotonically increasing _mk.ts.
    kitchenSession(sid = 'sess-' + crypto.randomUUID()) { return makeSession(k, sid); },
  };
  return k;
}

export function makeSession(k, sid) {
  let clock = Date.now();
  const tick = () => (clock += 5);
  const send = (hook_event_name, extra = {}, mk = {}) => {
    const ts = mk.ts ?? tick();
    if (mk.ts) clock = Math.max(clock, mk.ts);
    return k.post({ session_id: sid, hook_event_name, ...extra, _mk: { id: crypto.randomUUID(), ...mk, ts } });
  };
  const s = {
    id: sid,
    send,
    now: () => clock,
    tick,
    prompt: (text = 'an order', mk) => send('UserPromptSubmit', { prompt: text }, mk),
    stopTurn: mk => send('Stop', {}, mk),
    // Head Chef calls the Agent tool.
    call: (tool_use_id, type, description, prompt, mk, input = {}) =>
      send('PreToolUse', { tool_name: 'Agent', tool_use_id, tool_input: { subagent_type: type, description, prompt, ...input } }, mk),
    // The Agent tool returns, naming the cook it started.
    ret: (tool_use_id, tool_response, mk) => send('PostToolUse', { tool_name: 'Agent', tool_use_id, tool_response }, mk),
    start: (agent_id, agent_type, mk) => send('SubagentStart', { agent_id, agent_type }, mk),
    finish: (agent_id, agent_type, last_assistant_message, mk) => send('SubagentStop', { agent_id, agent_type, last_assistant_message }, mk),
    tool: (agent_id, agent_type, tool_name, tool_input, mk) =>
      send('PreToolUse', agent_id ? { agent_id, agent_type, tool_name, tool_input } : { tool_name, tool_input }, mk),
    get: () => k.session(sid),
    cook: id => k.cook(sid, id),
  };
  return s;
}

export function tempDir(prefix = 'mk-test-') { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
export function rmDir(d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }

// Run a node script with stdin input; resolve with code, stdout, stderr and duration.
export function runNode(args, { input, env = {}, timeout = 30000, cwd = ROOT } = {}) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const child = spawn(process.execPath, args, { cwd, env: childEnv(env), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    children.add(child);
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, timeout);
    child.on('close', (code, signal) => { clearTimeout(timer); children.delete(child); resolve({ code, signal, stdout, stderr, ms: Date.now() - t0 }); });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

// NODE_OPTIONS that makes any server.mjs started from a child write its pid to pidFile.
// With cwdFile, it also writes {pid, cwd} as one JSON line per server.
export function pidCaptureEnv(pidFile, cwdFile) {
  return { NODE_OPTIONS: `--import=${pathToFileURL(PID_PRELOAD).href}`, MK_TEST_PIDFILE: pidFile, ...(cwdFile ? { MK_TEST_CWDFILE: cwdFile } : {}) };
}

// Fallback when the preload did not report: ask the OS who listens on the port (no shell involved).
export function pidsListeningOn(port) {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true });
      return [...new Set(out.split(/\r?\n/).map(l => l.trim().split(/\s+/))
        .filter(c => c.length >= 5 && c[1].endsWith(':' + port) && /LISTEN/i.test(c[3])).map(c => Number(c[4])).filter(Boolean))];
    }
    const out = execFileSync('lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
    return out.split(/\s+/).map(Number).filter(Boolean);
  } catch { return []; }
}

export function killPid(pid) { try { process.kill(pid); return true; } catch { return false; } }

// pids written by pid-preload.mjs (one per line).
export function readPids(file) {
  try { return [...new Set(fs.readFileSync(file, 'utf8').split(/\s+/).map(Number).filter(Boolean))]; } catch { return []; }
}

// Kill every server a hook may have started: pids from the preload file plus whoever listens on the ports,
// then wait for the ports to come free and remove the hook's start lock for each port.
export async function cleanupStrays(pidFiles, ports) {
  const pids = new Set();
  for (const f of pidFiles) for (const p of readPids(f)) pids.add(p);
  for (const port of ports) for (const p of pidsListeningOn(port)) pids.add(p);
  for (const p of pids) killPid(p);
  for (const port of ports) {
    for (let i = 0; i < 30 && !(await portFree(port)); i++) await sleep(100);
    try { fs.unlinkSync(path.join(os.tmpdir(), `monkey-kitchen-${port}.lock`)); } catch { /* none */ }
  }
}

// A server-sent-events client: collects every parsed `data:` frame.
export function watch(port, p = '/events', headers = {}) {
  const frames = [];
  const waiters = [];
  let res0 = null;
  const req = http.get({ host: '127.0.0.1', port, path: p, agent: false, headers }, res => {
    res0 = res;
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = block.split('\n').find(l => l.startsWith('data: '));
        if (!line) continue;
        frames.push(JSON.parse(line.slice(6)));
        for (const w of [...waiters]) w();
      }
    });
    res.on('error', () => {});
  });
  req.on('error', () => {});
  const w = {
    frames,
    get headers() { return res0?.headers; },
    get last() { return frames[frames.length - 1]; },
    // Resolve with the first frame (from index `from`) for which pred is true, or null after ms.
    next(pred = () => true, ms = 3000, from = 0) {
      return new Promise(resolve => {
        const check = () => {
          for (let j = from; j < frames.length; j++) if (pred(frames[j])) { done(); resolve(frames[j]); return true; }
          return false;
        };
        const t = setTimeout(() => { done(); resolve(null); }, ms);
        const done = () => { clearTimeout(t); const k = waiters.indexOf(check); if (k >= 0) waiters.splice(k, 1); };
        if (!check()) waiters.push(check);
      });
    },
    close() { req.destroy(); },
  };
  return w;
}
