// The kitchen's keys. The master token (header x-mk-token) is the only key that writes (/hook, /shutdown); the
// read-only page key (cookie mk, header x-mk-page, the /?k= link) or the master token in its header reads the data
// endpoints; /health and the page's files are open, and /health?c= proves the server holds the key. Then the token
// file, its rotation, and the hook's side: it sends the key only to a kitchen that proved it holds it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  startKitchen, runNode, HOOK, ROOT, TEST_TOKEN, TEST_PAGE, proofFor, freePort, tempDir, rmDir, sleep, pidCaptureEnv, readPids, cleanupStrays,
} from './helpers/kitchen.mjs';
import { pageKey, healthProof } from '../server/token.mjs';

let k, dir;
const servers = [], pidFiles = [];
before(async () => { k = await startKitchen(); dir = tempDir('mk-lock-'); });
after(async () => {
  await k?.stop();
  for (const s of servers) { try { s.closeAllConnections?.(); s.close(); } catch { /* closed */ } }
  await cleanupStrays(pidFiles, []);
  rmDir(dir);
});

const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version;
const WRONG = 'ffffffffffffffffffffffffffffffff';
const hmac = (key, msg) => crypto.createHmac('sha256', key).update(msg).digest('hex');
const ev = sid => JSON.stringify({ session_id: sid, hook_event_name: 'UserPromptSubmit', prompt: 'x', _mk: { id: crypto.randomUUID(), ts: Date.now() } });
const startupInput = sid => JSON.stringify({ session_id: sid, hook_event_name: 'SessionStart', source: 'startup' });
const lastLine = stdout => JSON.parse(stdout).hookSpecificOutput.additionalContext.trimEnd().split('\n').pop();
const inHome = home => ({ MONKEY_KITCHEN_TOKEN: undefined, HOME: home, USERPROFILE: home });
const tokenPath = home => path.join(home, '.claude', 'monkey-kitchen', 'token');

// Ways of asking that must not read: [label, request options without path].
const NO_READ = [
  ['no key', { token: false }],
  ['a wrong master token', { token: WRONG }],
  ['a short key', { token: 'abc' }],
  ['an empty key', { token: false, headers: { 'x-mk-token': '' } }],
  ['the master token as cookie', { token: false, headers: { cookie: `mk=${TEST_TOKEN}` } }],
  ['the master token as x-mk-page', { token: false, headers: { 'x-mk-page': TEST_TOKEN } }],
  ['the page key as x-mk-token', { token: TEST_PAGE }],
  ['a wrong cookie', { token: false, headers: { cookie: `mk=${WRONG}` } }],
];
// Ways of asking that read.
const READ = [
  ['the master token in x-mk-token', {}],
  ['the page key as cookie', { token: false, headers: { cookie: `other=1; mk=${TEST_PAGE}` } }],
  ['the page key as x-mk-page', { token: false, headers: { 'x-mk-page': TEST_PAGE } }],
];
// Ways of asking that must not write: every NO_READ way, and the page key however it is sent.
const NO_WRITE = [
  ...NO_READ,
  ['the page key as cookie', { token: false, headers: { cookie: `mk=${TEST_PAGE}` } }],
  ['the page key as x-mk-page', { token: false, headers: { 'x-mk-page': TEST_PAGE } }],
];

test('the page key is HMAC-SHA256(token, "monkey-kitchen page key") cut to 32 hex, and differs from the token', () => {
  assert.equal(TEST_PAGE, hmac(TEST_TOKEN, 'monkey-kitchen page key').slice(0, 32));
  assert.match(TEST_PAGE, /^[0-9a-f]{32}$/);
  assert.notEqual(TEST_PAGE, TEST_TOKEN);
});

test('GET /events, /state, /cook and /chef: 401 {error: "locked"} unless read access is shown', async () => {
  const s = k.kitchenSession();
  await s.prompt('secret order');
  await s.start('a1', 'monkey-kitchen:line-cook');
  const q = 'session=' + encodeURIComponent(s.id);
  const paths = [`/events?${q}`, '/state', `/cook?${q}&id=a1`, `/chef?${q}`];
  for (const p of paths) {
    for (const [what, opts] of NO_READ) {
      const r = await k.request({ path: p, ...opts });
      assert.equal(r.status, 401, `${p} with ${what}`);
      assert.deepEqual(JSON.parse(r.body), { error: 'locked' }, `${p} body with ${what}`);
      assert.ok(!r.body.includes('secret order'));
    }
  }
  for (const p of paths.filter(x => !x.startsWith('/events'))) {
    for (const [what, opts] of READ) assert.equal((await k.request({ path: p, ...opts })).status, 200, `${p} with ${what}`);
  }
});

test('POST /hook takes only the master token in x-mk-token: anything else, the page key included, is 401 and not processed', async () => {
  for (const [what, opts] of NO_WRITE) {
    const sid = 'locked-hook-' + crypto.randomUUID();
    const r = await k.request({ method: 'POST', path: '/hook', body: ev(sid), ...opts, headers: { 'content-type': 'application/json', ...opts.headers } });
    assert.equal(r.status, 401, what);
    assert.equal(r.headers['x-monkey-kitchen'], '1', `kitchen header with ${what}`);
    assert.equal(await k.session(sid), null, `not processed with ${what}`);
  }
  const sid = 'open-hook-' + crypto.randomUUID();
  assert.equal((await k.post(ev(sid))).status, 204, 'control: with the master token');
  assert.ok(await k.session(sid));
});

test('POST /shutdown takes only the master token: anything else is 401 and the server stays up', async () => {
  for (const [what, opts] of NO_WRITE) {
    const r = await k.request({ method: 'POST', path: '/shutdown', body: '{}', ...opts });
    assert.equal(r.status, 401, what);
    assert.equal(r.headers['x-monkey-kitchen'], '1');
  }
  await sleep(200);
  assert.equal(k.child.exitCode, null, 'still running');
  assert.equal(await k.health(), 200);
});

test('GET /?k=<page key> sets the page-key cookie and redirects; the master token or a wrong k is 401 and sets nothing', async () => {
  const r = await k.request({ path: `/?k=${TEST_PAGE}`, token: false });
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, '/');
  const cookie = [].concat(r.headers['set-cookie'] || []);
  assert.deepEqual(cookie, [`mk=${TEST_PAGE}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`]);
  assert.ok(!cookie[0].includes(TEST_TOKEN), 'the cookie never holds the master token');
  const jar = cookie[0].split(';')[0];
  assert.equal((await k.request({ path: '/state', token: false, headers: { cookie: jar } })).status, 200, 'the cookie reads');
  assert.equal((await k.request({ method: 'POST', path: '/hook', token: false, headers: { cookie: jar }, body: ev('jar') })).status, 401, 'and does not write');
  for (const bad of [TEST_TOKEN, WRONG, '', 'nope', TEST_PAGE.toUpperCase()]) {
    const w = await k.request({ path: `/?k=${encodeURIComponent(bad)}`, token: false });
    assert.equal(w.status, 401, `k=${bad === TEST_TOKEN ? '<master token>' : bad}`);
    assert.match(w.headers['content-type'], /^text\/plain/);
    assert.match(w.body, /does not unlock/);
    assert.equal(w.headers['set-cookie'], undefined, 'no cookie');
  }
});

test('GET /auth is {ok: true} with read access, else 401 {ok: false}', async () => {
  for (const [what, opts] of READ) {
    const r = await k.request({ path: '/auth', ...opts });
    assert.equal(r.status, 200, what);
    assert.deepEqual(JSON.parse(r.body), { ok: true });
  }
  for (const [what, opts] of NO_READ) {
    const r = await k.request({ path: '/auth', ...opts });
    assert.equal(r.status, 401, what);
    assert.deepEqual(JSON.parse(r.body), { ok: false });
  }
});

test('GET /health and the page\'s own files are served without a key', async () => {
  const h = await k.request({ path: '/health', token: false });
  assert.equal(h.status, 200);
  assert.deepEqual(Object.keys(JSON.parse(h.body)).sort(), ['app', 'ok', 'root', 'version']);
  for (const p of ['/', '/index.html', '/kitchen.js', '/art.js', '/kitchen.css']) {
    const r = await k.request({ path: p, token: false });
    assert.equal(r.status, 200, p);
  }
});

test('GET /health?c=<32 hex> carries x-mk-proof = HMAC-SHA256(token, "health:" + c); a missing or malformed c gets none', async () => {
  const c = crypto.randomBytes(16).toString('hex');
  const r = await k.request({ path: `/health?c=${c}`, token: false });
  assert.equal(r.status, 200);
  assert.equal(r.headers['x-mk-proof'], hmac(TEST_TOKEN, 'health:' + c), 'valid proof');
  assert.equal(r.headers['x-mk-proof'], healthProof(TEST_TOKEN, c));
  const other = crypto.randomBytes(16).toString('hex');
  assert.notEqual(r.headers['x-mk-proof'], healthProof(TEST_TOKEN, other), 'a proof for one challenge does not answer another');
  assert.notEqual(r.headers['x-mk-proof'], healthProof(WRONG, c), 'nor one made with another key');
  assert.equal((await k.request({ path: '/health', token: false })).headers['x-mk-proof'], undefined, 'no challenge, no proof');
  for (const bad of [c.slice(1), c + '0', 'g'.repeat(32), '', 'x'.repeat(200)]) {
    const m = await k.request({ path: `/health?c=${encodeURIComponent(bad)}`, token: false });
    assert.equal(m.status, 200);
    assert.equal(m.headers['x-mk-proof'], undefined, `malformed c=${bad.slice(0, 40)}`);
  }
});

test('without MONKEY_KITCHEN_TOKEN the key lives in <home>/.claude/monkey-kitchen/token, created once and locked down, then reused', { timeout: 30000 }, async () => {
  const home = tempDir('mk-home-');
  const file = tokenPath(home);
  let kk;
  try {
    kk = await startKitchen(inHome(home));
    const t1 = fs.readFileSync(file, 'utf8').trim();
    assert.match(t1, /^[0-9a-f]{32}$/);
    if (process.platform === 'win32') {
      // Windows has no mode bits: the folder's inherited entries are removed and only the user is granted access.
      const acl = execFileSync('icacls', [path.dirname(file)], { encoding: 'utf8', windowsHide: true });
      assert.ok(!/\(I\)/.test(acl), 'no inherited entries on the key folder');
      assert.ok(acl.toLowerCase().includes(String(process.env.USERNAME).toLowerCase()), 'the user is granted access');
    } else {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'token file is 0600');
      assert.equal(fs.statSync(path.dirname(file)).mode & 0o077, 0, 'its folder is closed to others');
    }
    assert.equal((await kk.request({ path: '/state', token: t1 })).status, 200, 'the server uses the file key');
    assert.equal((await kk.request({ path: '/state' })).status, 401, 'and not the test key');
    // The hook, with the same home, finds the same key: its event gets in and its link carries the page key.
    const sid = 'filekey-' + crypto.randomUUID();
    const r = await runNode([HOOK, '--context'], { input: startupInput(sid), env: { ...inHome(home), MONKEY_KITCHEN_PORT: String(kk.port) } });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(lastLine(r.stdout).includes(`/?k=${pageKey(t1)} `));
    assert.ok(!r.stdout.includes(t1), 'the master token is not in the context');
    assert.ok(JSON.parse((await kk.request({ path: '/state', token: t1 })).body).sessions.some(s => s.id === sid), 'the hook\'s event arrived');
    await kk.stop();
    kk = await startKitchen(inHome(home));
    assert.equal(fs.readFileSync(file, 'utf8').trim(), t1, 'the next start reuses the file');
    assert.equal((await kk.request({ path: '/state', token: t1 })).status, 200);
  } finally { await kk?.stop(); rmDir(home); }
});

// resolveToken() in a child process whose home is `home`.
const TOKEN_URL = JSON.stringify(pathToFileURL(path.join(ROOT, 'server', 'token.mjs')).href);
const resolveIn = home => runNode(['--input-type=module', '-e', `import { resolveToken } from ${TOKEN_URL}; console.log(JSON.stringify(resolveToken()));`], { env: inHome(home) });

test('processes racing to create the token file all end up with the same key', { timeout: 30000 }, async () => {
  const home = tempDir('mk-race-');
  try {
    const runs = await Promise.all(Array.from({ length: 6 }, () => resolveIn(home)));
    for (const r of runs) assert.equal(r.code, 0, r.stderr);
    const keys = runs.map(r => JSON.parse(r.stdout));
    assert.match(keys[0], /^[0-9a-f]{32}$/);
    assert.equal(new Set(keys).size, 1, 'one key');
    assert.equal(fs.readFileSync(tokenPath(home), 'utf8').trim(), keys[0]);
    assert.deepEqual(fs.readdirSync(path.dirname(tokenPath(home))), ['token'], 'no temporary files left');
  } finally { rmDir(home); }
});

test('the token file: an unreadable one is never deleted, uppercase hex is accepted, a damaged one is replaced', { timeout: 30000 }, async () => {
  const home = tempDir('mk-tokfile-');
  const file = tokenPath(home);
  try {
    // Unreadable (here: a folder where the file should be): no key, and nothing is deleted.
    fs.mkdirSync(file, { recursive: true });
    const unreadable = await resolveIn(home);
    assert.equal(unreadable.code, 0, unreadable.stderr);
    assert.equal(JSON.parse(unreadable.stdout), null);
    assert.ok(fs.statSync(file).isDirectory(), 'left where it was');
    fs.rmdirSync(file);
    // Uppercase: read as lowercase; the file is left as it is.
    fs.writeFileSync(file, 'ABCDEF0123456789ABCDEF0123456789\n');
    assert.equal(JSON.parse((await resolveIn(home)).stdout), 'abcdef0123456789abcdef0123456789');
    assert.equal(fs.readFileSync(file, 'utf8'), 'ABCDEF0123456789ABCDEF0123456789\n');
    // Read fine but not a key (and not being written): replaced by a new key.
    fs.writeFileSync(file, 'not a key');
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(file, old, old);
    const fresh = JSON.parse((await resolveIn(home)).stdout);
    assert.match(fresh, /^[0-9a-f]{32}$/);
    assert.equal(fs.readFileSync(file, 'utf8').trim(), fresh);
  } finally { rmDir(home); }
});

test('a replaced key file is adopted by the running server: the next hook proves, posts and links the new page key', { timeout: 30000 }, async () => {
  const home = tempDir('mk-rotate-');
  const file = tokenPath(home);
  let kk;
  try {
    kk = await startKitchen(inHome(home));
    const t1 = fs.readFileSync(file, 'utf8').trim();
    fs.unlinkSync(file); // the user rotates the key: the next hook creates a new one
    const sid = 'rotated-' + crypto.randomUUID();
    const r = await runNode([HOOK, '--context'], { input: startupInput(sid), env: { ...inHome(home), MONKEY_KITCHEN_PORT: String(kk.port) } });
    assert.equal(r.code, 0, r.stderr);
    const t2 = fs.readFileSync(file, 'utf8').trim();
    assert.notEqual(t2, t1);
    assert.equal(lastLine(r.stdout), `The live kitchen view is at http://localhost:${kk.port}/?k=${pageKey(t2)} (this link unlocks the page in your browser; share it only with the user).`);
    assert.equal((await kk.request({ path: '/state', token: t1 })).status, 401, 'the old key no longer reads');
    assert.equal((await kk.request({ path: '/state', token: false, headers: { cookie: `mk=${pageKey(t1)}` } })).status, 401, 'nor the old page key');
    const st = await kk.request({ path: '/state', token: t2 });
    assert.equal(st.status, 200, 'the new key does');
    assert.ok(JSON.parse(st.body).sessions.some(s => s.id === sid), 'the hook\'s event arrived');
    assert.equal(kk.child.exitCode, null, 'the same server, not a replacement');
  } finally { await kk?.stop(); rmDir(home); }
});

// A stand-in kitchen of the current version that records what the hook sends. `proof`: 'valid' (holds TEST_TOKEN),
// 'none' or 'wrong'. `hookStatus` is its /hook answer.
async function fakeKitchen({ proof = 'valid', hookStatus = 204 } = {}) {
  const hits = [];
  const port = await freePort();
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      hits.push({ method: req.method, url: req.url, headers: req.headers });
      if (req.url.startsWith('/health')) {
        const headers = { 'content-type': 'application/json', 'x-monkey-kitchen': '1' };
        if (proof === 'valid') headers['x-mk-proof'] = proofFor(req.url);
        if (proof === 'wrong') headers['x-mk-proof'] = proofFor(req.url, WRONG);
        res.writeHead(200, headers).end(JSON.stringify({ ok: true, app: 'monkey-kitchen', version: VERSION, root: ROOT }));
        return;
      }
      res.writeHead(req.url === '/hook' ? hookStatus : 204, { 'x-monkey-kitchen': '1' }).end();
    });
  });
  await new Promise(r => srv.listen(port, '127.0.0.1', r));
  servers.push(srv);
  return { port, hits, posts: () => hits.filter(h => h.method === 'POST') };
}

test('the hook challenges /health with a fresh 32-hex nonce, and sends the master token only on POST /hook to a kitchen that proved it', async () => {
  const f = await fakeKitchen();
  const r = await runNode([HOOK], { input: JSON.stringify({ session_id: 'hdr', hook_event_name: 'UserPromptSubmit', prompt: 'x' }), env: { MONKEY_KITCHEN_PORT: String(f.port) } });
  assert.equal(r.code, 0, r.stderr);
  const health = f.hits.filter(h => h.url.startsWith('/health'));
  assert.equal(health.length, 1);
  assert.match(health[0].url, /^\/health\?c=[0-9a-f]{32}$/);
  const posts = f.posts();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, '/hook');
  assert.equal(posts[0].headers['x-mk-token'], TEST_TOKEN);
  for (const h of f.hits.filter(x => x.method === 'GET')) assert.equal(h.headers['x-mk-token'], undefined, `${h.url} carries no key`);
});

test('with --context the last line is the link with the page key; the master token appears nowhere', async () => {
  const sid = 'link-' + crypto.randomUUID();
  const r = await runNode([HOOK, '--context'], { input: startupInput(sid), env: { MONKEY_KITCHEN_PORT: String(k.port) } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(lastLine(r.stdout), `The live kitchen view is at http://localhost:${k.port}/?k=${TEST_PAGE} (this link unlocks the page in your browser; share it only with the user).`);
  assert.ok(!r.stdout.includes(TEST_TOKEN), 'no master token in the context');
  assert.ok(await k.session(sid), 'the event got in');
});

for (const proof of ['none', 'wrong']) {
  test(`a kitchen whose /health proof is ${proof === 'none' ? 'missing' : 'wrong'} gets no token and no payload; at startup the context says it uses a different key`, { timeout: 20000 }, async () => {
    const f = await fakeKitchen({ proof });
    const pidFile = path.join(dir, `pids-locked-${proof}.txt`);
    pidFiles.push(pidFile);
    const env = { MONKEY_KITCHEN_PORT: String(f.port), ...pidCaptureEnv(pidFile) };
    const r = await runNode([HOOK, '--context'], { input: startupInput('lk-' + proof), env });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.ms < 3000, `took ${r.ms} ms`);
    assert.match(lastLine(r.stdout), new RegExp(`server on port ${f.port} uses a different key.*Stop it once`));
    assert.ok(!r.stdout.includes(TEST_PAGE) && !r.stdout.includes(TEST_TOKEN), 'no link, no key');
    const quiet = await runNode([HOOK], { input: JSON.stringify({ session_id: 'lk', hook_event_name: 'UserPromptSubmit', prompt: 'x' }), env });
    assert.equal(quiet.code, 0, quiet.stderr);
    assert.equal(quiet.stdout, '');
    assert.deepEqual(f.posts(), [], 'no payload and no shutdown request');
    assert.ok(f.hits.every(h => h.headers['x-mk-token'] === undefined), 'the token was never sent');
    await sleep(300);
    assert.deepEqual(readPids(pidFile), [], 'no server started');
  });
}

test('a port that never answers: no link and no key in the context, only that the view could not be started', { timeout: 20000 }, async () => {
  const sockets = [];
  const hold = net.createServer(s => { sockets.push(s); s.on('error', () => {}); });
  const port = await freePort();
  await new Promise(r => hold.listen(port, '127.0.0.1', r));
  try {
    const r = await runNode([HOOK, '--context'], { input: startupInput('mute'), env: { MONKEY_KITCHEN_PORT: String(port) } });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(lastLine(r.stdout), `The kitchen view could not be started on port ${port}.`);
    assert.ok(!r.stdout.includes(TEST_PAGE));
  } finally { for (const s of sockets) s.destroy(); await new Promise(r => hold.close(r)); }
});

test('with no usable home folder the hook sends nothing and says no key file could be created', { timeout: 20000 }, async () => {
  const f = await fakeKitchen();
  const notADir = path.join(dir, 'home-is-a-file');
  fs.writeFileSync(notADir, 'x');
  const r = await runNode([HOOK, '--context'], { input: startupInput('nokey'), env: { ...inHome(notADir), MONKEY_KITCHEN_PORT: String(f.port) } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(lastLine(r.stdout), 'The kitchen view is unavailable: no key file could be created in your home folder.');
  assert.deepEqual(f.hits, [], 'the port was not even asked');
});
