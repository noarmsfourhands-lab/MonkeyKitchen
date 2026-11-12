// Robustness: duplicates, junk input, HTTP guards, static files, project naming.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { startKitchen, ROOT, TEST_TOKEN } from './helpers/kitchen.mjs';

let k;
before(async () => { k = await startKitchen(); });
after(async () => { await k?.stop(); });

const LINE = 'monkey-kitchen:line-cook';

test('a duplicate _mk.id is processed once', async () => {
  const s = k.kitchenSession();
  await s.prompt();
  await s.start('a1', LINE);
  const mk = { id: 'dup-' + s.id, ts: Date.now() };
  await s.tool('a1', LINE, 'Read', { file_path: 'once.txt' }, mk);
  await s.tool('a1', LINE, 'Read', { file_path: 'once.txt' }, mk);
  const c = await s.cook('a1');
  assert.equal(c.tools, 1);
  assert.equal(c.log.length, 1);
});

test('a body that is not JSON does not crash the server', async () => {
  await k.post('not json');
  assert.equal(await k.health(), 200);
  assert.equal(k.child.exitCode, null);
});

test('agent_id set with agent_type null does not crash the server', async () => {
  const s = k.kitchenSession();
  await s.prompt();
  await s.send('SubagentStart', { agent_id: 'n1', agent_type: null });
  await s.send('PreToolUse', { agent_id: 'n1', agent_type: null, tool_name: 'Read', tool_input: { file_path: 'a' } });
  await s.send('PreToolUse', { agent_id: 'n2', agent_type: null, tool_name: 'Agent', tool_input: { subagent_type: null } });
  await s.send('PostToolUseFailure', { agent_id: 'n1', agent_type: null, tool_name: 'Bash' });
  await s.send('SubagentStop', { agent_id: 'n1', agent_type: null, last_assistant_message: null });
  assert.equal(await k.health(), 200);
  assert.equal(k.child.exitCode, null);
  assert.ok(await s.get(), 'session still served by /state');
});

test('GET /health answers 200', async () => {
  const r = await k.request({ path: '/health' });
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).ok, true);
});

test('GET /%E0%A4%A returns 400', async () => {
  const r = await k.request({ path: '/%E0%A4%A' });
  assert.equal(r.status, 400);
});

test('GET /state with a foreign Host header returns 403', async () => {
  const ok = await k.request({ path: '/state' });
  assert.equal(ok.status, 200, 'control: own host is allowed');
  const r = await k.request({ path: '/state', headers: { host: `evil.example:${k.port}` } });
  assert.equal(r.status, 403);
});

test('POST /hook with an Origin header returns 403 and is not processed', async () => {
  const sid = 'origin-' + Date.now();
  const r = await k.request({
    method: 'POST', path: '/hook', headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ session_id: sid, hook_event_name: 'UserPromptSubmit', prompt: 'x', _mk: { id: sid, ts: Date.now() } }),
  });
  assert.equal(r.status, 403);
  assert.equal(await k.session(sid), null);
});

test('an oversized POST /hook body returns 413', async () => {
  // Stream the body in chunks and stop sending as soon as the server answers,
  // as a well-behaved client would.
  const total = 6 * 1024 * 1024, chunk = Buffer.alloc(64 * 1024, 'a');
  const status = await new Promise((resolve, reject) => {
    let answered = false;
    const req = http.request({ host: '127.0.0.1', port: k.port, path: '/hook', method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': total, 'x-mk-token': TEST_TOKEN } }, res => {
      answered = true; res.resume(); resolve(res.statusCode);
    });
    req.on('error', e => { if (!answered) reject(e); });
    (async () => {
      for (let sent = 0; sent < total && !answered; sent += chunk.length) {
        if (!req.write(chunk)) await new Promise(r => req.once('drain', r));
      }
      if (!answered) req.end();
    })().catch(() => {});
  }).catch(e => `error: ${e.code || e.message}`);
  assert.equal(status, 413);
  assert.equal(await k.health(), 200, 'server still up');
});

test('path traversal does not return files outside web/', async () => {
  const pkg = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8');
  const pricing = fs.readFileSync(path.join(ROOT, 'server', 'pricing.json'), 'utf8');
  const control = await k.request({ path: '/' });
  assert.equal(control.status, 200, 'control: index.html is served');
  const attempts = [
    ['/..%2fpackage.json', pkg], ['/%2e%2e%2fpackage.json', pkg], ['/..%5cpackage.json', pkg], ['/../package.json', pkg],
    ['/..%2fserver%2fpricing.json', pricing], ['/%2e%2e/server/pricing.json', pricing], ['/..%2f..%2f' + path.basename(ROOT) + '%2fpackage.json', pkg],
  ];
  for (const [p, content] of attempts) {
    const r = await k.request({ path: p });
    assert.notEqual(r.status, 200, `${p} must not succeed`);
    assert.ok(!r.body.includes(content.slice(0, 40)), `${p} must not return the file`);
  }
});

// GET /events (v2 frames) is covered in feed.test.mjs.

test('project name comes from _mk.projectDir when present', async () => {
  const s = k.kitchenSession();
  await s.send('SessionStart', { cwd: '/home/u/somewhere-else' }, { projectDir: '/home/u/alpha-proj' });
  assert.equal((await s.get()).project, 'alpha-proj');
  const w = k.kitchenSession();
  await w.send('SessionStart', { cwd: 'C:\\work\\other' }, { projectDir: 'C:\\work\\beta-proj' });
  assert.equal((await w.get()).project, 'beta-proj');
});

test('without projectDir the project is the first cwd and a later cwd does not rename it', async () => {
  const s = k.kitchenSession();
  await s.send('SessionStart', { cwd: '/home/u/first-dir' });
  assert.equal((await s.get()).project, 'first-dir');
  await s.send('UserPromptSubmit', { prompt: 'x', cwd: '/home/u/first-dir/sub/second-dir' });
  await s.send('PreToolUse', { tool_name: 'Read', tool_input: {}, cwd: '/tmp/third-dir' });
  assert.equal((await s.get()).project, 'first-dir');
});
