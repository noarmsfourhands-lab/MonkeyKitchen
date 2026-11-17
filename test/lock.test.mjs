// The kitchen's key. The page needs none: the data GETs (/events, /state, /cook, /chef) answer any request whose Host
// names this server, and ignore any ?k=, x-mk-page header or cookie; a foreign Host is 403 and no CORS header is
// sent. The master token (header x-mk-token) is the only key that writes (/hook, /shutdown), a POST with an Origin
// header is 403, and /health?c= proves the server holds the key. An old /?k= link goes to /. Then the token file, its
// rotation, and the hook's side: it sends the key only to a kitchen that proved it holds it, and links the plain
// address. No response and no printed line ever carries the master token.
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
  startKitchen, runNode, HOOK, ROOT, TEST_TOKEN, proofFor, freePort, tempDir, rmDir, sleep, pidCaptureEnv, readPids, cleanupStrays, watch,
} from './helpers/kitchen.mjs';
import { healthProof } from '../server/token.mjs';

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
const plainLink = (host, port) => `The live kitchen view is at http://${host}:${port}.`;
// What 0.3.2 derived as the page key, and what 0.3.0/0.3.1 did: neither means anything now.
const OLD_PAGE = hmac(TEST_TOKEN, 'monkey-kitchen page key v2').slice(0, 32);
const OLDER_PAGE = hmac(TEST_TOKEN, 'monkey-kitchen page key').slice(0, 32);

// Ways of asking for data. None is needed, and none changes the answer: every one reads.
const READS = [
  ['no key', { token: false }],
  ['a wrong x-mk-token', { token: WRONG }],
  ['the master token in x-mk-token', {}],
  ['a wrong x-mk-page', { token: false, headers: { 'x-mk-page': WRONG } }],
  ['the old page key as x-mk-page', { token: false, headers: { 'x-mk-page': OLD_PAGE } }],
  ['a cookie', { token: false, headers: { cookie: `other=1; mk=${OLD_PAGE}` } }],
  ['a wrong cookie', { token: false, headers: { cookie: `mk=${WRONG}` } }],
];
// The same, with ?k= on the URL (a wrong one, the old page key, the master token, an empty one).
const QUERY_KEYS = [WRONG, OLD_PAGE, OLDER_PAGE, TEST_TOKEN, ''];
const withQuery = (p, v) => `${p}${p.includes('?') ? '&' : '?'}k=${encodeURIComponent(v)}`;

// Ways of asking that must not write: everything but the master token in x-mk-token.
const NO_WRITE = [
  ['no key', { token: false }],
  ['a wrong master token', { token: WRONG }],
  ['a short key', { token: 'abc' }],
  ['an empty key', { token: false, headers: { 'x-mk-token': '' } }],
  ['the master token in capitals', { token: TEST_TOKEN.toUpperCase() }],
  ['the master token as cookie', { token: false, headers: { cookie: `mk=${TEST_TOKEN}` } }],
  ['the master token as x-mk-page', { token: false, headers: { 'x-mk-page': TEST_TOKEN } }],
  ['the old page key as x-mk-token', { token: OLD_PAGE }],
  ['the old page key as x-mk-page', { token: false, headers: { 'x-mk-page': OLD_PAGE } }],
];
// A Set-Cookie for mk that is anything but the removal of the old cookie.
const keyCookies = r => [].concat(r.headers['set-cookie'] || []).filter(c => /^\s*mk=/i.test(c) && !/^\s*mk=;\s*Max-Age=0;\s*Path=\/$/i.test(c));
const corsHeaders = r => Object.keys(r.headers).filter(h => h.startsWith('access-control-'));

// A session with an order and a cook, and the four data paths for it.
async function seeded(text) {
  const s = k.kitchenSession();
  await s.prompt(text);
  await s.start('a1', 'monkey-kitchen:line-cook');
  const q = 'session=' + encodeURIComponent(s.id);
  return { s, q, json: ['/state', `/cook?${q}&id=a1`, `/chef?${q}`], events: `/events?${q}` };
}

test('GET /state, /cook and /chef answer 200 with the data and no key; a key, a cookie or ?k= changes nothing', async () => {
  const { json } = await seeded('open order');
  for (const p of json) {
    for (const [what, opts] of READS) {
      const r = await k.request({ path: p, ...opts });
      assert.equal(r.status, 200, `${p} with ${what}`);
      assert.match(r.headers['content-type'], /^application\/json/);
    }
    for (const v of QUERY_KEYS) assert.equal((await k.request({ path: withQuery(p, v), token: false })).status, 200, `${p} with ?k=`);
  }
  const st = await k.request({ path: '/state', token: false });
  assert.ok(st.body.includes('open order'), 'the data itself, with no key');
  const cook = JSON.parse((await k.request({ path: json[1], token: false })).body);
  assert.equal(cook.id, 'a1');
});

test('GET /cook and /chef for something that does not exist are 404, never 401', async () => {
  const { q } = await seeded('missing order');
  for (const p of [`/cook?${q}&id=nobody`, '/cook', `/chef?session=no-such-${crypto.randomUUID()}`, '/chef']) {
    const r = await k.request({ path: p, token: false });
    assert.equal(r.status, 404, p);
  }
});

test('GET /events opens a stream with no key and sends frames; ?k=, x-mk-page and cookies are ignored', async () => {
  const { s, events } = await seeded('stream order');
  for (const [what, opts] of READS) {
    const r = await k.peek({ path: events, ...opts });
    assert.equal(r.status, 200, `/events with ${what}`);
    assert.match(r.headers['content-type'], /^text\/event-stream/);
  }
  for (const v of QUERY_KEYS) assert.equal((await k.peek({ path: withQuery(events, v), token: false })).status, 200, '/events with ?k=');
  assert.equal((await k.peek({ path: '/events', token: false })).status, 200, 'without a session too');
  const w = watch(k.port, events);
  try {
    const f = await w.next(x => x.session?.id === s.id && x.session.order?.text === 'stream order');
    assert.ok(f, 'a frame for the session, read with no key');
  } finally { w.close(); }
});

test('a foreign Host is 403 on every GET, even with the master token; our three hosts are accepted', async () => {
  const { json, events } = await seeded('host order');
  const foreign = [`evil.example:${k.port}`, `127.0.0.1:${k.port + 1}`, `localhost.evil.example:${k.port}`, `[::2]:${k.port}`, '127.0.0.1'];
  for (const host of foreign) {
    for (const p of [...json, events, '/', '/kitchen.js', '/health', '/?k=x']) {
      for (const token of [false, TEST_TOKEN]) {
        const r = await k.request({ path: p, token, headers: { host } });
        assert.equal(r.status, 403, `${p} with Host ${host}`);
        assert.ok(!r.body.includes('host order'));
      }
    }
  }
  // An empty Host, and none at all (HTTP/1.0), sent by hand: Node's own client would fill in a default.
  for (const head of ['GET /state HTTP/1.1\r\nHost: \r\nConnection: close', 'GET /state HTTP/1.0']) {
    const answer = await new Promise((resolve, reject) => {
      let data = '';
      const sock = net.connect(k.port, '127.0.0.1', () => sock.write(head + '\r\n\r\n'));
      sock.setEncoding('utf8');
      sock.on('data', d => { data += d; });
      sock.on('end', () => resolve(data));
      sock.on('error', reject);
      sock.setTimeout(5000, () => { sock.destroy(); resolve(data); });
    });
    assert.match(answer, /^HTTP\/1\.[01] (400|403) /, JSON.stringify(head));
    assert.ok(!answer.includes('host order'));
  }
  for (const host of [`127.0.0.1:${k.port}`, `localhost:${k.port}`, `LOCALHOST:${k.port}`, `[::1]:${k.port}`]) {
    assert.equal((await k.request({ path: '/state', token: false, headers: { host } })).status, 200, `Host ${host}`);
  }
});

test('no CORS headers on any answer, whatever Origin a request names', async () => {
  const { json, events } = await seeded('cors order');
  for (const origin of ['http://evil.example', 'null', `http://localhost:${k.port}`]) {
    for (const p of [...json, '/', '/health']) {
      const r = await k.request({ path: p, token: false, headers: { origin } });
      assert.deepEqual(corsHeaders(r), [], `${p} from ${origin}`);
    }
    assert.deepEqual(corsHeaders(await k.peek({ path: events, token: false, headers: { origin } })), [], `/events from ${origin}`);
  }
  // A preflight is not answered either.
  const pre = await k.request({ method: 'OPTIONS', path: '/state', token: false, headers: { origin: 'http://evil.example', 'access-control-request-method': 'GET' } });
  assert.equal(pre.status, 405);
  assert.deepEqual(corsHeaders(pre), []);
});

test('other methods on the data paths are 405', async () => {
  for (const method of ['PUT', 'DELETE', 'PATCH']) {
    for (const p of ['/state', '/events', '/cook', '/chef']) assert.equal((await k.request({ method, path: p, token: false, body: '' })).status, 405, `${method} ${p}`);
  }
});

test('GET /auth is gone (404)', async () => {
  for (const opts of [{ token: false }, {}, { token: false, headers: { 'x-mk-page': OLD_PAGE } }]) {
    assert.equal((await k.request({ path: '/auth', ...opts })).status, 404);
  }
});

test('POST /hook takes only the master token in x-mk-token: anything else is 401 and not processed', async () => {
  for (const [what, opts] of NO_WRITE) {
    const sid = 'locked-hook-' + crypto.randomUUID();
    const r = await k.request({ method: 'POST', path: '/hook', body: ev(sid), ...opts, headers: { 'content-type': 'application/json', ...opts.headers } });
    assert.equal(r.status, 401, what);
    assert.equal(r.headers['x-monkey-kitchen'], '1', `kitchen header with ${what}`);
    assert.equal(await k.session(sid), null, `not processed with ${what}`);
  }
  // Nor does a key in the query.
  for (const key of [TEST_TOKEN, OLD_PAGE]) {
    const sid = 'qk-' + crypto.randomUUID();
    assert.equal((await k.request({ method: 'POST', path: `/hook?k=${key}`, token: false, body: ev(sid) })).status, 401, 'POST /hook?k=');
    assert.equal(await k.session(sid), null, 'not processed');
  }
  const sid = 'open-hook-' + crypto.randomUUID();
  assert.equal((await k.post(ev(sid))).status, 204, 'control: with the master token');
  assert.ok(await k.session(sid));
});

test('POST /hook and /shutdown with an Origin header are 403, the master token notwithstanding', async () => {
  for (const origin of ['http://evil.example', `http://localhost:${k.port}`, 'null']) {
    const sid = 'origin-' + crypto.randomUUID();
    const r = await k.request({ method: 'POST', path: '/hook', body: ev(sid), headers: { 'content-type': 'application/json', origin } });
    assert.equal(r.status, 403, `/hook from ${origin}`);
    assert.equal(await k.session(sid), null, 'not processed');
    assert.equal((await k.request({ method: 'POST', path: '/shutdown', body: '{}', headers: { origin } })).status, 403, `/shutdown from ${origin}`);
  }
  await sleep(200);
  assert.equal(k.child.exitCode, null, 'still running');
});

test('POST /shutdown takes only the master token: anything else is 401 and the server stays up', async () => {
  for (const [what, opts] of NO_WRITE) {
    const r = await k.request({ method: 'POST', path: '/shutdown', body: '{}', ...opts });
    assert.equal(r.status, 401, what);
    assert.equal(r.headers['x-monkey-kitchen'], '1');
  }
  for (const key of [TEST_TOKEN, OLD_PAGE]) assert.equal((await k.request({ method: 'POST', path: `/shutdown?k=${key}`, token: false, body: '{}' })).status, 401);
  await sleep(200);
  assert.equal(k.child.exitCode, null, 'still running');
  assert.equal(await k.health(), 200);
});

test('an old GET /?k=<anything> link goes to / (no fragment, no key); uncached, no referrer, old cookie cleared', async () => {
  for (const v of [OLD_PAGE, OLDER_PAGE, TEST_TOKEN, WRONG, OLD_PAGE.toUpperCase(), 'nope', '', 'a%20b%0D%0Ax']) {
    const label = v === TEST_TOKEN ? '<master key>' : v;
    const r = await k.request({ path: `/?k=${v}`, token: false });
    assert.equal(r.status, 302, `k=${label}`);
    assert.equal(r.headers.location, '/', `k=${label}`);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers['referrer-policy'], 'no-referrer');
    assert.deepEqual([].concat(r.headers['set-cookie'] || []), ['mk=; Max-Age=0; Path=/'], 'the old cookie is cleared, no key cookie set');
  }
});

test('GET / removes the cookie earlier versions set; no response sets a key cookie', async () => {
  const home = await k.request({ path: '/', token: false, headers: { cookie: `mk=${OLD_PAGE}` } });
  assert.equal(home.status, 200);
  assert.deepEqual([].concat(home.headers['set-cookie'] || []), ['mk=; Max-Age=0; Path=/']);
  const { json, events } = await seeded('cookie order');
  const asks = [
    ...['/', '/index.html', '/kitchen.js', '/health', `/health?c=${'a'.repeat(32)}`, ...json, '/nope', `/?k=${OLD_PAGE}`]
      .flatMap(p => [{ path: p }, { path: p, token: false }, { path: p, token: false, headers: { cookie: `mk=${OLD_PAGE}` } }]),
    { method: 'POST', path: '/hook', body: ev('ck-' + crypto.randomUUID()) },
    { method: 'POST', path: '/hook', token: false, body: ev('ck-' + crypto.randomUUID()) },
  ];
  for (const a of asks) assert.deepEqual(keyCookies(await k.request(a)), [], `${a.method || 'GET'} ${a.path}`);
  for (const a of [{ path: events }, { path: events, token: false }]) assert.deepEqual(keyCookies(await k.peek(a)), [], a.path);
});

test('no response, header or body, ever carries the master token', async () => {
  const { json, events } = await seeded(`token order ${crypto.randomUUID()}`);
  const asks = [
    ...['/', '/index.html', '/kitchen.js', '/art.js', '/kitchen.css', '/health', `/health?c=${crypto.randomBytes(16).toString('hex')}`, ...json, '/auth', '/nope', `/?k=${TEST_TOKEN}`, `/state?k=${TEST_TOKEN}`]
      .flatMap(p => [{ path: p }, { path: p, token: false }]),
    { method: 'POST', path: '/hook', body: ev('tk-' + crypto.randomUUID()) },
    { method: 'POST', path: '/hook', token: false, body: ev('tk-' + crypto.randomUUID()) },
    { method: 'POST', path: '/shutdown', token: WRONG, body: '{}' },
    { path: '/state', headers: { host: `evil.example:${k.port}` } },
  ];
  for (const a of asks) {
    const r = await k.request(a);
    assert.ok(!r.body.includes(TEST_TOKEN) && !JSON.stringify(r.headers).includes(TEST_TOKEN), `${a.method || 'GET'} ${a.path}`);
  }
  assert.ok(!JSON.stringify((await k.peek({ path: events, token: false })).headers).includes(TEST_TOKEN));
  const w = watch(k.port, events);
  try {
    assert.ok(await w.next(() => true), 'a frame arrived');
    assert.ok(!JSON.stringify(w.frames).includes(TEST_TOKEN), 'not in a frame');
  } finally { w.close(); }
});

test('the server\'s startup line is the plain link, with no key', async () => {
  const line = k.stdout().split(/\r?\n/)[0];
  assert.equal(line, `Monkey Kitchen is open at http://${await k.linkHost()}:${k.port}`);
  assert.ok(!k.stdout().includes('k=') && !k.stdout().includes(TEST_TOKEN));
});

test('GET /health and the page\'s own files are served without a key', async () => {
  const h = await k.request({ path: '/health', token: false });
  assert.equal(h.status, 200);
  assert.deepEqual(Object.keys(JSON.parse(h.body)).sort(), ['app', 'ok', 'root', 'v6', 'version']);
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
    assert.equal((await kk.request({ method: 'POST', path: '/hook', token: t1, body: ev('fk-' + crypto.randomUUID()) })).status, 204, 'the server uses the file key');
    assert.equal((await kk.request({ method: 'POST', path: '/hook', body: ev('fk-' + crypto.randomUUID()) })).status, 401, 'and not the test key');
    assert.ok(!kk.stdout().includes(t1), 'the startup line has no key');
    // The hook, with the same home, finds the same key: its event gets in, and its link is the plain address.
    const sid = 'filekey-' + crypto.randomUUID();
    const r = await runNode([HOOK, '--context'], { input: startupInput(sid), env: { ...inHome(home), MONKEY_KITCHEN_PORT: String(kk.port) } });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(lastLine(r.stdout), plainLink(await kk.linkHost(), kk.port));
    assert.ok(!r.stdout.includes(t1), 'the master token is not in the context');
    assert.ok(JSON.parse((await kk.request({ path: '/state', token: false })).body).sessions.some(s => s.id === sid), 'the hook\'s event arrived');
    await kk.stop();
    kk = await startKitchen(inHome(home));
    assert.equal(fs.readFileSync(file, 'utf8').trim(), t1, 'the next start reuses the file');
    assert.equal((await kk.request({ method: 'POST', path: '/hook', token: t1, body: ev('fk-' + crypto.randomUUID()) })).status, 204);
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

test('a replaced key file is adopted by the running server: the next hook proves and posts, the old key no longer writes, open pages keep their stream', { timeout: 30000 }, async () => {
  const home = tempDir('mk-rotate-');
  const file = tokenPath(home);
  let kk, w;
  try {
    kk = await startKitchen(inHome(home));
    const t1 = fs.readFileSync(file, 'utf8').trim();
    w = watch(kk.port, '/events'); // a page open before the rotation
    assert.ok(await w.next(() => true), 'the page is connected');
    fs.unlinkSync(file); // the user rotates the key: the next hook creates a new one
    const sid = 'rotated-' + crypto.randomUUID();
    const r = await runNode([HOOK, '--context'], { input: startupInput(sid), env: { ...inHome(home), MONKEY_KITCHEN_PORT: String(kk.port) } });
    assert.equal(r.code, 0, r.stderr);
    const t2 = fs.readFileSync(file, 'utf8').trim();
    assert.notEqual(t2, t1);
    assert.equal(lastLine(r.stdout), plainLink(await kk.linkHost(), kk.port));
    assert.ok(!r.stdout.includes(t1) && !r.stdout.includes(t2), 'no key in the context');
    assert.ok(await w.next(f => f.sessions.some(s => s.id === sid)), 'the page opened before the rotation sees the new event');
    assert.equal((await kk.request({ method: 'POST', path: '/hook', token: t1, body: ev('old-' + crypto.randomUUID()) })).status, 401, 'the old key no longer writes');
    assert.equal((await kk.request({ method: 'POST', path: '/hook', token: t2, body: ev('new-' + crypto.randomUUID()) })).status, 204, 'the new key does');
    const st = await kk.request({ path: '/state', token: false });
    assert.equal(st.status, 200, 'reading still needs no key');
    assert.ok(JSON.parse(st.body).sessions.some(s => s.id === sid), 'the hook\'s event arrived');
    assert.equal(kk.child.exitCode, null, 'the same server, not a replacement');
  } finally { w?.close(); await kk?.stop(); rmDir(home); }
});

// A stand-in kitchen of the current version that records what the hook sends. `proof`: 'valid' (holds TEST_TOKEN),
// 'none' or 'wrong'. `hookStatus` is its /hook answer.
async function fakeKitchen({ proof = 'valid', hookStatus = 204, v6 } = {}) {
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
        res.writeHead(200, headers).end(JSON.stringify({ ok: true, app: 'monkey-kitchen', version: VERSION, root: ROOT, ...(v6 === undefined ? {} : { v6 }) }));
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

test('with --context the last line is the plain link, with no k= and no master token anywhere', async () => {
  const sid = 'link-' + crypto.randomUUID();
  const r = await runNode([HOOK, '--context'], { input: startupInput(sid), env: { MONKEY_KITCHEN_PORT: String(k.port) } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(lastLine(r.stdout), plainLink(await k.linkHost(), k.port));
  assert.ok(!lastLine(r.stdout).includes('k='), 'no key in the link');
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
    assert.ok(!r.stdout.includes('live kitchen view is at') && !r.stdout.includes(TEST_TOKEN), 'no link, no key');
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
    assert.ok(!r.stdout.includes(TEST_TOKEN));
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

// ---------- IPv6 loopback: the link names localhost only when the kitchen also listens on [::1] ----------

// A GET to [::1]:port, or null when this machine has no IPv6 loopback.
const get6 = (port, p, headers = {}) => new Promise(resolve => {
  const req = http.get({ host: '::1', family: 6, port, path: p, headers, agent: false }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
  req.on('error', () => resolve(null));
  req.setTimeout(3000, () => { req.destroy(); resolve(null); });
});

test('/health says whether the kitchen also listens on [::1]; Host [::1]:PORT is accepted, and with v6 on [::1] answers', async () => {
  const h = JSON.parse((await k.request({ path: '/health', token: false })).body);
  assert.equal(typeof h.v6, 'boolean');
  const host6 = { host: `[::1]:${k.port}` };
  assert.equal((await k.request({ path: '/health', token: false, headers: host6 })).status, 200, 'Host [::1]:PORT accepted');
  assert.equal((await k.request({ path: '/state', token: false, headers: host6 })).status, 200);
  assert.equal((await k.request({ path: '/state', token: false, headers: { host: `[::2]:${k.port}` } })).status, 403, 'another address is not');
  if (!h.v6) return; // no IPv6 loopback here (some CI runners): nothing listens on [::1]
  assert.equal(await get6(k.port, '/health'), 200, '[::1] answers');
  assert.equal(await get6(k.port, '/state'), 200, 'with no key, as on 127.0.0.1');
  assert.equal(await get6(k.port, '/state', { host: `evil.example:${k.port}` }), 403, 'and checks the Host the same way');
});

test('MONKEY_KITCHEN_NO_V6=1: no [::1] listener, /health v6 false, and the hook\'s link names 127.0.0.1', { timeout: 20000 }, async () => {
  const kk = await startKitchen({ MONKEY_KITCHEN_NO_V6: '1' });
  try {
    assert.equal(JSON.parse((await kk.request({ path: '/health' })).body).v6, false);
    assert.equal(await get6(kk.port, '/health'), null, 'nothing on [::1]');
    assert.equal(kk.stdout().split(/\r?\n/)[0], `Monkey Kitchen is open at http://127.0.0.1:${kk.port}`);
    const r = await runNode([HOOK, '--context'], { input: startupInput('nov6-' + crypto.randomUUID()), env: { MONKEY_KITCHEN_PORT: String(kk.port) } });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(lastLine(r.stdout), plainLink('127.0.0.1', kk.port));
  } finally { await kk.stop(); }
});

for (const [v6, host] of [[true, 'localhost'], [false, '127.0.0.1'], [undefined, '127.0.0.1']]) {
  test(`a proven kitchen whose /health has ${v6 === undefined ? 'no v6' : `v6: ${v6}`} gets a link with host ${host}`, async () => {
    const f = await fakeKitchen({ v6 });
    const r = await runNode([HOOK, '--context'], { input: startupInput('v6-' + String(v6)), env: { MONKEY_KITCHEN_PORT: String(f.port) } });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(lastLine(r.stdout), plainLink(host, f.port));
  });
}
