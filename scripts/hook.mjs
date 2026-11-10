#!/usr/bin/env node
// Relays one Claude Code hook payload (JSON on stdin) to the kitchen server,
// starting the server if it isn't running. Never fails the hook: a kitchen
// that is closed must not get in the way of the session.
//
//   node hook.mjs            relay only
//   node hook.mjs --context  relay, then print the brigade rules for SessionStart

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.MONKEY_KITCHEN_PORT) || 4747;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function post(body, timeout = 600) {
  return new Promise(resolve => {
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: '/hook', method: 'POST', timeout,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, res => { res.resume(); res.on('end', () => resolve(true)); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end(body);
  });
}

function startServer() {
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'server.mjs')], {
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.unref();
}

try {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;

  if (raw.trim()) {
    let ok = await post(raw);
    if (!ok) {
      startServer();
      for (let i = 0; i < 10 && !ok; i++) { await sleep(200); ok = await post(raw); }
    }
  }

  if (process.argv.includes('--context') && process.env.MONKEY_KITCHEN_ROUTING !== 'off') {
    const rules = fs.readFileSync(path.join(ROOT, 'brigade', 'head-chef.md'), 'utf8');
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: `${rules}\nThe live kitchen view is at http://localhost:${PORT}.`,
      },
    }));
  }
} catch { /* stay silent */ }
process.exit(0);
