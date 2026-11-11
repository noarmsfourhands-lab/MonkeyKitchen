// Hardening: bad session ids and transcript paths, the session cap, oversized bodies, the kitchen header,
// /health and /shutdown.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { startKitchen, sleep, tempDir, rmDir, ROOT } from './helpers/kitchen.mjs';

let k, dir;
before(async () => { k = await startKitchen(); dir = tempDir('mk-hard-'); });
after(async () => { await k?.stop(); rmDir(dir); });

const ev = (session_id, extra = {}) => ({ session_id, hook_event_name: 'UserPromptSubmit', prompt: 'x', ...extra, _mk: { id: crypto.randomUUID(), ts: Date.now() } });
const sessionIds = async () => (await k.state()).sessions.map(s => s.id);

test('events with a missing, non-string, empty or over-128-char session_id are ignored', async () => {
  const beforeIds = await sessionIds();
  const bad = [undefined, 42, { a: 1 }, ['x'], null, true, '', 'x'.repeat(129)];
  for (const sid of bad) {
    const p = ev(sid); if (sid === undefined) delete p.session_id;
    const r = await k.post(p);
    assert.equal(r.status, 204);
  }
  assert.equal(await k.health(), 200, 'server up');
  assert.equal(k.child.exitCode, null);
  const st = await k.state();
  assert.deepEqual(st.sessions.map(s => s.id).sort(), beforeIds.sort(), 'no session created');
  // Boundary control: 128 chars is accepted.
  const ok = 'y'.repeat(128);
  await k.post(ev(ok));
  assert.ok(await k.session(ok), 'a 128-char session_id is accepted');
});

const rec = id => JSON.stringify({ type: 'assistant', uuid: id, message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 100, output_tokens: 10 } } }) + '\n';

test('a valid transcript_path is metered (control for the next test)', async () => {
  const f = path.join(dir, 'good.jsonl');
  fs.writeFileSync(f, rec('g1'));
  const sid = 'tp-good-' + crypto.randomUUID();
  await k.post(ev(sid, { transcript_path: f }));
  await k.post({ ...ev(sid, { transcript_path: f }), hook_event_name: 'Stop' });
  const s = await k.until(x => x.sessions.find(y => y.id === sid)?.usage, 5000);
  assert.ok(s, 'usage appears for a valid path');
});

test('a UNC transcript_path or one not ending in .jsonl is treated as absent (usage stays null)', async () => {
  // A real local file reached through a \\?\ path (starts with two backslashes) and a real file with the wrong extension:
  // if either were accepted the meter would find usage.
  const real = path.join(dir, 'real.jsonl');
  fs.writeFileSync(real, rec('r1'));
  const txt = path.join(dir, 'real.txt');
  fs.writeFileSync(txt, rec('t1'));
  const paths = ['\\\\host\\share\\x.jsonl', txt, real + '.bak'];
  if (process.platform === 'win32') paths.push('\\\\?\\' + real);
  const sids = [];
  for (const p of paths) {
    const sid = 'tp-bad-' + crypto.randomUUID();
    sids.push(sid);
    await k.post(ev(sid, { transcript_path: p }));
    await k.post({ ...ev(sid, { transcript_path: p }), hook_event_name: 'Stop' });
  }
  await sleep(1200); // scans run ~300 ms after Stop
  for (const [i, sid] of sids.entries()) {
    const s = await k.session(sid);
    assert.ok(s, 'session exists');
    assert.equal(s.usage, null, `usage null for ${paths[i]}`);
  }
  assert.equal(await k.health(), 200);
});

test('at most 50 sessions are kept; the least recently active one is evicted', { timeout: 20000 }, async () => {
  const kk = await startKitchen();
  try {
    const ids = Array.from({ length: 50 }, (_, i) => `cap-${i}`);
    for (const id of ids) { await kk.post(ev(id)); await sleep(2); }
    let st = await kk.state();
    assert.equal(st.sessions.length, 50);
    await kk.post(ev('cap-0')); // cap-0 is active again; cap-1 is now the least recent
    await sleep(2);
    await kk.post(ev('cap-50'));
    st = await kk.state();
    const have = new Set(st.sessions.map(s => s.id));
    assert.equal(st.sessions.length, 50);
    assert.ok(have.has('cap-50'), 'new session kept');
    assert.ok(have.has('cap-0'), 'recently active session kept');
    assert.ok(!have.has('cap-1'), 'least recently active evicted');
    await kk.post(ev('cap-51'));
    st = await kk.state();
    assert.equal(st.sessions.length, 50);
    assert.ok(!st.sessions.some(s => s.id === 'cap-2'), 'next least recent evicted');
  } finally { await kk.stop(); }
});

test('an oversized body gets 413 even when the client sends the whole body', { timeout: 20000 }, async () => {
  const body = Buffer.alloc(6 * 1024 * 1024, 'a');
  const r = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: k.port, path: '/hook', method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': body.length } }, res => {
      res.resume(); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(body);
  });
  assert.equal(r.status, 413);
  assert.equal(await k.health(), 200, 'server still up');
});

test('POST /hook answers carry x-monkey-kitchen: 1', async () => {
  const r = await k.post(ev('hdr-' + crypto.randomUUID()));
  assert.equal(r.status, 204);
  assert.equal(r.headers['x-monkey-kitchen'], '1');
  const junk = await k.post('not json');
  assert.equal(junk.headers['x-monkey-kitchen'], '1', 'also for a body that is not JSON');
});

test('GET /health returns {ok, app, version, root} with the plugin.json version', async () => {
  const r = await k.request({ path: '/health' });
  assert.equal(r.status, 200);
  const h = JSON.parse(r.body);
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version;
  assert.deepEqual(Object.keys(h).sort(), ['app', 'ok', 'root', 'version']);
  assert.equal(h.ok, true);
  assert.equal(h.app, 'monkey-kitchen');
  assert.equal(h.version, version);
  const norm = p => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
  assert.equal(norm(h.root), norm(ROOT));
});

test('POST /shutdown with an Origin header is refused; without one the server exits', { timeout: 15000 }, async () => {
  const kk = await startKitchen();
  try {
    const refused = await kk.request({ method: 'POST', path: '/shutdown', headers: { origin: 'https://evil.example' }, body: '{}' });
    assert.equal(refused.status, 403);
    await sleep(200);
    assert.equal(kk.child.exitCode, null, 'still running');
    assert.equal(await kk.health(), 200);
    const exited = new Promise(r => kk.child.once('exit', code => r(code)));
    const ok = await kk.request({ method: 'POST', path: '/shutdown', body: '{}' });
    assert.ok(ok.status >= 200 && ok.status < 300, `status ${ok.status}`);
    const code = await Promise.race([exited, sleep(3000).then(() => 'timeout')]);
    assert.equal(code, 0, 'server exited cleanly');
  } finally { await kk.stop(); }
});
