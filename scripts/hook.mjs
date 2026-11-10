#!/usr/bin/env node
// Relays one Claude Code hook payload (JSON on stdin) to the kitchen server,
// starting the server if it isn't running. Never fails the hook: a kitchen
// that is closed must not get in the way of the session.
//
//   node hook.mjs            relay only
//   node hook.mjs --context  relay, then print the brigade rules for SessionStart

const TS = Date.now(); // the event time; async hooks can reach the server out of order

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.MONKEY_KITCHEN_PORT) || 4747;
const BUDGET_MS = 2800; // reaching or starting the server may never hold the session up longer than this
const sleep = ms => new Promise(r => setTimeout(r, ms));

function post(body, timeout) {
  return new Promise(resolve => {
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: '/hook', method: 'POST', timeout, agent: false,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, res => { res.resume(); resolve('ok'); }); // any HTTP answer, 4xx/5xx included, means the server is there
    req.on('error', e => resolve(e.code === 'ECONNREFUSED' ? 'refused' : 'fail'));
    req.on('timeout', () => { req.destroy(); resolve('fail'); });
    req.end(body);
  });
}

function startServer() {
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'server.mjs')], {
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.on('error', () => {});
  child.unref();
}

async function relay(body) {
  const t0 = Date.now();
  const left = () => BUDGET_MS - (Date.now() - t0);
  // Only a refused connection means no server is running; a timeout or reset must not spawn another.
  if ((await post(body, Math.min(600, left()))) !== 'refused') return;
  startServer();
  while (left() > 250) {
    await sleep(200);
    if ((await post(body, Math.max(50, Math.min(600, left())))) === 'ok') return;
  }
}

setTimeout(() => process.exit(0), BUDGET_MS + 1500).unref(); // last resort if stdin or the network hangs

let out = '';
try {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;

  let payload = null;
  try { payload = JSON.parse(raw); } catch { /* not JSON: relay nothing */ }
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    payload._mk = { id: crypto.randomUUID(), ts: TS, projectDir: process.env.CLAUDE_PROJECT_DIR || null };
    await relay(JSON.stringify(payload));
  }

  if (process.argv.includes('--context') && process.env.MONKEY_KITCHEN_ROUTING !== 'off') {
    const rules = fs.readFileSync(path.join(ROOT, 'brigade', 'head-chef.md'), 'utf8');
    out = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: `${rules}\nThe live kitchen view is at http://localhost:${PORT}.`,
      },
    });
  }
} catch { /* stay silent */ }
// Exit only once stdout has flushed: process.exit() right after a write can truncate piped output.
process.stdout.on('error', () => process.exit(0)); // a closed pipe (EPIPE) must not fail the hook
if (out) process.stdout.write(out, () => process.exit(0)); else process.exit(0);
