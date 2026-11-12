// scripts/hook.mjs: relays one payload from stdin to the server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {
  startKitchen, runNode, HOOK, ROOT, freePort, portFree, request, tempDir, rmDir, sleep,
  pidCaptureEnv, pidsListeningOn, killPid,
} from './helpers/kitchen.mjs';

let k;
let dir;
const strays = []; // ports where the hook may have started its own server
before(async () => { k = await startKitchen(); dir = tempDir('mk-hook-'); });
after(async () => {
  await k?.stop();
  // Kill any server the hook started for itself.
  const pidFile = path.join(dir, 'pids.txt');
  const pids = new Set();
  try { for (const l of fs.readFileSync(pidFile, 'utf8').split(/\s+/)) if (Number(l)) pids.add(Number(l)); } catch { /* none */ }
  for (const port of strays) for (const p of pidsListeningOn(port)) pids.add(p);
  for (const p of pids) killPid(p);
  for (const port of strays) {
    for (let i = 0; i < 30 && !(await portFree(port)); i++) await sleep(100);
  }
  rmDir(dir);
});

const payload = (sid, extra = {}) => JSON.stringify({ session_id: sid, hook_event_name: 'UserPromptSubmit', prompt: 'hook order', ...extra });

test('with a server listening: payload is delivered, exit 0, nothing on stdout', async () => {
  const sid = 'hook-' + Date.now();
  const r = await runNode([HOOK], { input: payload(sid), env: { MONKEY_KITCHEN_PORT: String(k.port), CLAUDE_PROJECT_DIR: path.join(dir, 'hook-project') } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, '');
  const s = await k.session(sid);
  assert.ok(s, 'session visible in /state');
  assert.equal(s.order?.text, 'hook order');
  assert.equal(s.project, 'hook-project', 'projectDir from CLAUDE_PROJECT_DIR');
});

test('with --context: stdout is JSON whose additionalContext contains brigade/head-chef.md', async () => {
  const rules = fs.readFileSync(path.join(ROOT, 'brigade', 'head-chef.md'), 'utf8');
  const sid = 'hookctx-' + Date.now();
  const r = await runNode([HOOK, '--context'], { input: payload(sid, { hook_event_name: 'SessionStart', source: 'startup' }), env: { MONKEY_KITCHEN_PORT: String(k.port) } });
  assert.equal(r.code, 0, r.stderr);
  let out;
  assert.doesNotThrow(() => { out = JSON.parse(r.stdout); }, 'stdout is valid JSON');
  assert.equal(typeof out.hookSpecificOutput?.additionalContext, 'string');
  assert.ok(out.hookSpecificOutput.additionalContext.includes(rules), 'contains the whole head-chef.md');
  assert.ok(await k.session(sid), 'payload also delivered');
});

test('with --context and MONKEY_KITCHEN_ROUTING=off: the rules are left out but the kitchen link is still given', async () => {
  const sid = 'hookoff-' + Date.now();
  const r = await runNode([HOOK, '--context'], { input: payload(sid, { hook_event_name: 'SessionStart' }), env: { MONKEY_KITCHEN_PORT: String(k.port), MONKEY_KITCHEN_ROUTING: 'off' } });
  assert.equal(r.code, 0, r.stderr);
  const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.ok(!ctx.includes('Rules of the pass'), 'no routing rules');
  assert.ok(ctx.includes('routing rules are switched off'), 'says routing is off');
  assert.match(ctx, new RegExp(`The live kitchen view is at http://localhost:${k.port}/\\?k=[0-9a-f]{32}`), 'still carries the keyed link');
});

test('with invalid JSON on stdin: exit 0 and nothing is posted', async () => {
  const hits = [];
  const port = await freePort();
  const rec = http.createServer((req, res) => { hits.push(req.method + ' ' + req.url); req.resume(); res.writeHead(204).end(); });
  await new Promise(r => rec.listen(port, '127.0.0.1', r));
  try {
    const r = await runNode([HOOK], { input: '{ this is not json', env: { MONKEY_KITCHEN_PORT: String(port) } });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, '');
    await sleep(200);
    assert.deepEqual(hits, []);
  } finally {
    await new Promise(r => rec.close(r));
  }
});

test('with nothing listening: exits 0 within 5 seconds', async () => {
  const port = await freePort();
  strays.push(port);
  const pidFile = path.join(dir, 'pids.txt');
  const sid = 'hookcold-' + Date.now();
  const r = await runNode([HOOK], { input: payload(sid), env: { MONKEY_KITCHEN_PORT: String(port), ...pidCaptureEnv(pidFile) }, timeout: 15000 });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.ms < 5000, `took ${r.ms} ms`);
  assert.equal(r.stdout, '');
  // It started its own server on that port (killed in after()).
  const h = await request(port, { path: '/health' }).catch(() => null);
  assert.equal(h?.status, 200, 'hook started a server on the chosen port');
});
