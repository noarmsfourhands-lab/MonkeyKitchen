// The kitchen's key. The server and the hook resolve it the same way. The page needs none.
//
//   master token  32 hex characters: MONKEY_KITCHEN_TOKEN when it holds one (tests set it), else the file
//                 <home>/.claude/monkey-kitchen/token, created on first use (mode 0600 in a 0700 folder; on Windows
//                 the folder's inherited access is replaced by the user alone). It lets the hooks write (POST /hook,
//                 POST /shutdown), and only ever travels in the x-mk-token header of the local hook.
//   health proof  hex HMAC-SHA256(token, 'health:' + nonce): how a server shows the hook it holds the same token.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFile } from 'node:child_process';

const VALID = /^[0-9a-f]{32}$/;
const pause = ms => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no wait available */ } };
const normal = s => String(s ?? '').trim().toLowerCase();

export const tokenFile = () => path.join(os.homedir(), '.claude', 'monkey-kitchen', 'token');
export const envToken = () => { const t = normal(process.env.MONKEY_KITCHEN_TOKEN); return VALID.test(t) ? t : null; };

// { state: 'ok', key } | { state: 'missing' } | { state: 'bad', mtimeMs } (read, but not a key) | { state: 'error' }
export function readTokenFile(file = tokenFile()) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return { state: e.code === 'ENOENT' ? 'missing' : 'error' }; }
  const key = normal(text);
  if (VALID.test(key)) return { state: 'ok', key };
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(file).mtimeMs; } catch { /* raced */ }
  return { state: 'bad', mtimeMs };
}

// Windows ignores mode bits, and a new folder inherits whoever may read ~/.claude: keep only the user. Best effort.
function icaclsArgs(target, dir) {
  const user = process.env.USERNAME;
  if (!user) return null;
  const who = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${user}` : user;
  return [target, '/inheritance:r', '/grant:r', `${who}:${dir ? '(OI)(CI)F' : 'F'}`];
}
function lockDown(target, dir) {
  if (process.platform !== 'win32') return;
  const args = icaclsArgs(target, dir);
  if (!args) return;
  try { spawnSync('icacls', args, { windowsHide: true, timeout: 3000, stdio: 'ignore' }); } catch { /* not available: leave it */ }
}
// The same without blocking: resolves once icacls has finished (or failed, or timed out).
const lockDownLater = (target, dir) => new Promise(resolve => {
  const args = process.platform === 'win32' ? icaclsArgs(target, dir) : null;
  if (!args) { resolve(); return; }
  try { execFile('icacls', args, { windowsHide: true, timeout: 3000 }, () => resolve()); } catch { resolve(); }
});
// Re-applies the folder (and file) restriction.
export function hardenTokenFile(file = tokenFile()) {
  if (process.platform === 'win32') { lockDown(path.dirname(file), true); if (fs.existsSync(file)) lockDown(file, false); return; }
  try { if (fs.statSync(file).mode & 0o077) fs.chmodSync(file, 0o600); } catch { /* not ours to change */ }
}
// hardenTokenFile without holding up the caller: the server runs it once it is listening, so a slow icacls (up to
// two 3 s calls) never delays its first answer to the hook that started it. Never rejects.
export async function hardenTokenFileLater(file = tokenFile()) {
  if (process.platform !== 'win32') { hardenTokenFile(file); return; }
  await lockDownLater(path.dirname(file), true);
  if (fs.existsSync(file)) await lockDownLater(file, false);
}

// A complete file appears at once: written aside, then linked (fails if one exists) or renamed (replaces) into place.
function place(file, key, replace) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try { fs.writeSync(fd, key + '\n'); } finally { fs.closeSync(fd); }
  try {
    if (replace) fs.renameSync(tmp, file);
    else {
      try { fs.linkSync(tmp, file); } catch (e) {
        if (e.code === 'EEXIST') throw e;
        // No hard links on this file system: exclusive create instead (a reader may briefly see it empty).
        const f2 = fs.openSync(file, 'wx', 0o600);
        try { fs.writeSync(f2, key + '\n'); } finally { fs.closeSync(f2); }
      }
    }
  } finally { try { fs.unlinkSync(tmp); } catch { /* renamed away */ } }
}

// Returns the master token, or null when none can be had (no usable home folder, an unreadable file).
export function resolveToken() {
  const env = envToken();
  if (env) return env;
  let file;
  try { file = tokenFile(); } catch { return null; }
  let errors = 0;
  for (let attempt = 0; attempt < 30; attempt++) {
    const r = readTokenFile(file);
    if (r.state === 'ok') return r.key;
    if (r.state === 'error') {
      // Unreadable is not damaged: never delete it, try a few more times, then give up.
      if (++errors >= 5) return null;
      pause(20);
      continue;
    }
    try {
      if (r.state === 'missing') {
        const dir = path.dirname(file);
        const fresh = !fs.existsSync(dir);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        if (fresh) lockDown(dir, true);
        place(file, crypto.randomBytes(16).toString('hex'), false);
      } else if (Date.now() - r.mtimeMs > 2000) {
        // Read, but empty or not a key, and not being written right now: replace it in one step.
        place(file, crypto.randomBytes(16).toString('hex'), true);
        pause(50); // a process replacing it at the same moment: whichever rename came last is read by both below
      } else pause(20); // possibly half-written by a creator without hard links
    } catch (e) {
      if (e.code !== 'EEXIST') { if (++errors >= 5) return null; pause(20); }
    }
    // Loop: adopt whatever is in the file now, ours or a racing process's.
  }
  return null;
}

const hmac = (token, msg) => crypto.createHmac('sha256', token).update(msg).digest('hex');
export const NONCE = /^[0-9a-fA-F]{32}$/;
export const healthProof = (token, nonce) => (token && NONCE.test(String(nonce)) ? hmac(token, 'health:' + nonce) : null);

// Constant-time comparison of a presented value with the real one.
export function sameToken(given, token) {
  if (typeof given !== 'string' || typeof token !== 'string' || !token) return false;
  const a = Buffer.from(given), b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
