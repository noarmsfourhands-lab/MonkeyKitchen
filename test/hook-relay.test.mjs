// scripts/hook.mjs run as a child process: what it relays, foreign ports, start stampedes,
// the version handshake, and the working directory of the server it starts.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  runNode, HOOK, ROOT, freePort, request, tempDir, rmDir, sleep, pidCaptureEnv, readPids, cleanupStrays, pidsListeningOn,
} from './helpers/kitchen.mjs';

let dir;
const strays = []; // ports where a hook may have started a real server
const pidFiles = [];
const servers = [];
const dirs = []; // removed after the servers are gone (a server holding one as its cwd would block it)
before(() => { dir = tempDir('mk-relay-'); });
after(async () => {
  for (const s of servers) { try { s.closeAllConnections?.(); s.close(); } catch { /* closed */ } }
  await cleanupStrays(pidFiles, strays);
  for (const d of dirs) rmDir(d);
  rmDir(dir);
});

const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version;
const lockFile = port => path.join(os.tmpdir(), `monkey-kitchen-${port}.lock`);
let nPid = 0;
const newPidFile = () => { const f = path.join(dir, `pids-${nPid++}.txt`); pidFiles.push(f); return f; };

// A small HTTP server that records every request. `handler(req, body, res)` may answer; otherwise 204 (+ kitchen header if `kitchen`).
async function capture({ kitchen = true, handler } = {}) {
  const hits = [];
  const port = await freePort();
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      hits.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (handler && handler(req, body, res, srv) !== false) return;
      res.writeHead(204, kitchen ? { 'x-monkey-kitchen': '1' } : {}).end();
    });
  });
  await new Promise(r => srv.listen(port, '127.0.0.1', r));
  servers.push(srv);
  return { port, hits, srv, posts: () => hits.filter(h => h.method === 'POST' && h.url === '/hook'), close: () => new Promise(r => { srv.closeAllConnections?.(); srv.close(r); }) };
}

const BIG = 'z'.repeat(1024 * 1024);

test('the hook relays only whitelisted fields: large tool_response and tool_input.content are dropped', async () => {
  const cap = await capture();
  const env = { MONKEY_KITCHEN_PORT: String(cap.port), CLAUDE_PROJECT_DIR: path.join(dir, 'proj') };
  const post = { session_id: 's1', hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 't1', tool_input: { file_path: 'a.txt' }, tool_response: BIG, effort: { level: 'high' }, extra_unknown: BIG };
  const write = { session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'Write', tool_use_id: 't2', tool_input: { file_path: 'b.txt', content: BIG }, effort: 'medium' };
  const agent = {
    session_id: 's1', hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 't3', tool_input: { subagent_type: 'monkey-kitchen:taster', description: 'd', prompt: 'p' },
    tool_response: { agentId: 'ag1', status: 'completed', resolvedModel: 'claude-opus-5-5', content: [{ type: 'text', text: BIG }], totalTokens: 5, usage: { input_tokens: 1 } },
  };
  for (const p of [post, write, agent]) {
    const r = await runNode([HOOK], { input: JSON.stringify(p), env });
    assert.equal(r.code, 0, r.stderr);
  }
  const posts = cap.posts();
  assert.equal(posts.length, 3);
  for (const h of posts) assert.ok(Buffer.byteLength(h.body) < 10 * 1024, `body is ${h.body.length} bytes`);
  const [b1, b2, b3] = posts.map(h => JSON.parse(h.body));
  assert.ok(!('tool_response' in b1), 'non-Agent tool_response dropped');
  assert.ok(!('extra_unknown' in b1), 'unknown field dropped');
  assert.deepEqual(b1.effort, { level: 'high' }, 'effort survives');
  assert.equal(b1.tool_input.file_path, 'a.txt');
  assert.ok(!('content' in b2.tool_input), 'Write content dropped');
  assert.equal(b2.tool_input.file_path, 'b.txt');
  assert.equal(b2.effort, 'medium', 'string effort survives');
  assert.deepEqual(b3.tool_response, { agentId: 'ag1', status: 'completed', resolvedModel: 'claude-opus-5-5' });
  assert.equal(b3.tool_input.subagent_type, 'monkey-kitchen:taster');
  for (const b of [b1, b2, b3]) {
    assert.deepEqual(Object.keys(b._mk).sort(), ['id', 'projectDir', 'ts']);
    assert.equal(typeof b._mk.id, 'string');
    assert.equal(typeof b._mk.ts, 'number');
    assert.equal(b._mk.projectDir, env.CLAUDE_PROJECT_DIR);
  }
  assert.notEqual(b1._mk.id, b2._mk.id);
  await cap.close();
});

test('foreign port (no x-monkey-kitchen header): the hook exits 0 quickly, posts at most once, starts no server', async () => {
  const cap = await capture({ kitchen: false });
  const pidFile = newPidFile();
  const r = await runNode([HOOK], { input: JSON.stringify({ session_id: 'f1', hook_event_name: 'UserPromptSubmit', prompt: 'x' }), env: { MONKEY_KITCHEN_PORT: String(cap.port), ...pidCaptureEnv(pidFile) } });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.ms < 2000, `took ${r.ms} ms`);
  assert.ok(cap.posts().length <= 1, `posted ${cap.posts().length} times`);
  await sleep(300);
  assert.deepEqual(readPids(pidFile), [], 'no server started');
  await cap.close();
});

test('foreign port with --context: additionalContext ends with a note that the kitchen view is off', async () => {
  // Answers /health with some other app's JSON, and everything else without the kitchen header.
  const cap = await capture({
    kitchen: false,
    handler: (req, body, res) => { if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true,"app":"something-else"}'); return true; } return false; },
  });
  const pidFile = newPidFile();
  const r = await runNode([HOOK, '--context'], { input: JSON.stringify({ session_id: 'f2', hook_event_name: 'SessionStart', source: 'startup' }), env: { MONKEY_KITCHEN_PORT: String(cap.port), ...pidCaptureEnv(pidFile) } });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.ms < 2000, `took ${r.ms} ms`);
  assert.ok(cap.posts().length <= 1, `posted ${cap.posts().length} times`);
  assert.equal(cap.hits.filter(h => h.url === '/shutdown').length, 0, 'never asks a foreign program to shut down');
  const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx.trimEnd().split('\n').pop(), /kitchen view is off.*port \d+ is used by another program/i);
  assert.ok(ctx.includes(String(cap.port)));
  await sleep(300);
  assert.deepEqual(readPids(pidFile), [], 'no server started');
  await cap.close();
});

test('start stampede: 6 hooks at once with nothing listening start exactly one server, all exit 0, all events arrive', { timeout: 30000 }, async () => {
  const port = await freePort();
  strays.push(port);
  try { fs.unlinkSync(lockFile(port)); } catch { /* none */ }
  const pidFile = newPidFile();
  const env = { MONKEY_KITCHEN_PORT: String(port), ...pidCaptureEnv(pidFile) };
  const sids = Array.from({ length: 6 }, (_, i) => `stampede-${i}-${Date.now()}`);
  const results = await Promise.all(sids.map(sid => runNode([HOOK], { input: JSON.stringify({ session_id: sid, hook_event_name: 'UserPromptSubmit', prompt: 'p ' + sid }), env, timeout: 15000 })));
  for (const r of results) assert.equal(r.code, 0, r.stderr);
  await sleep(300);
  const started = readPids(pidFile);
  assert.equal(started.length, 1, `server processes started: ${started.length}`);
  const listening = pidsListeningOn(port);
  assert.equal(listening.length, 1, `processes listening on the port: ${listening.join(',')}`);
  const st = JSON.parse((await request(port, { path: '/state' })).body);
  for (const sid of sids) assert.ok(st.sessions.find(s => s.id === sid), `event from ${sid} arrived`);
  assert.equal(fs.existsSync(lockFile(port)), false, 'lock file removed');
});

test('version handshake: with --context, a kitchen of another version is asked to shut down and a real server takes its place', { timeout: 30000 }, async () => {
  let fakeUp = true;
  const cap = await capture({
    handler: (req, body, res, srv) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json', 'x-monkey-kitchen': '1' }).end(JSON.stringify({ ok: true, app: 'monkey-kitchen', version: '0.0.1-old', root: ROOT }));
        return true;
      }
      if (req.url === '/shutdown') {
        res.writeHead(204, { 'x-monkey-kitchen': '1' }).end(() => { fakeUp = false; srv.closeAllConnections?.(); srv.close(); });
        return true;
      }
      return false; // /hook: 204 with the header
    },
  });
  const port = cap.port;
  strays.push(port);
  const pidFile = newPidFile();
  const sid = 'handshake-' + Date.now();
  const r = await runNode([HOOK, '--context'], { input: JSON.stringify({ session_id: sid, hook_event_name: 'SessionStart', source: 'startup' }), env: { MONKEY_KITCHEN_PORT: String(port), ...pidCaptureEnv(pidFile) }, timeout: 15000 });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(cap.hits.filter(h => h.method === 'POST' && h.url === '/shutdown').length, 1, 'old server asked to shut down');
  assert.equal(fakeUp, false);
  assert.equal(cap.posts().length, 0, 'the event did not go to the old server');
  const h = JSON.parse((await request(port, { path: '/health' })).body);
  assert.equal(h.app, 'monkey-kitchen');
  assert.equal(h.version, VERSION, 'a server of the current version now owns the port');
  assert.equal(readPids(pidFile).length, 1, 'the hook started it');
  const st = JSON.parse((await request(port, { path: '/state' })).body);
  assert.ok(st.sessions.find(s => s.id === sid), 'the event reached the new server');
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /live kitchen view is at/);
});

test('the auto-started server runs with the plugin root as its working directory, not the hook\'s cwd', { timeout: 30000 }, async () => {
  const port = await freePort();
  strays.push(port);
  const hookCwd = tempDir('mk-hookcwd-');
  dirs.push(hookCwd);
  const pidFile = newPidFile();
  const cwdFile = path.join(dir, 'cwd.txt');
  const sid = 'cwd-' + Date.now();
  const r = await runNode([HOOK], { cwd: hookCwd, input: JSON.stringify({ session_id: sid, hook_event_name: 'UserPromptSubmit', prompt: 'x' }), env: { MONKEY_KITCHEN_PORT: String(port), ...pidCaptureEnv(pidFile, cwdFile) }, timeout: 15000 });
  assert.equal(r.code, 0, r.stderr);
  const h = JSON.parse((await request(port, { path: '/health' })).body);
  assert.equal(h.app, 'monkey-kitchen', 'a server answers');
  const rows = fs.readFileSync(cwdFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(rows.length, 1);
  const norm = p => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
  assert.equal(norm(rows[0].cwd), norm(ROOT), "server's process.cwd() is the plugin root");
  // On Windows a process's working folder cannot be deleted: deleting the hook's folder must succeed while the server runs.
  let removed = true;
  try { fs.rmSync(hookCwd, { recursive: true, force: false }); } catch { removed = false; }
  if (!removed) rmDir(hookCwd);
  assert.equal(removed, true, "the hook's folder can be deleted while the server runs");
  assert.equal((await request(port, { path: '/health' })).status, 200, 'server still running');
});
