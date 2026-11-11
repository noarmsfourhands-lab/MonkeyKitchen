// Loaded through NODE_OPTIONS by the hook tests: when the process is the kitchen
// server (started by hook.mjs), record its pid so the test can kill it afterwards,
// and (with MK_TEST_CWDFILE) its pid and working directory.
import fs from 'node:fs';

if (/server[\\/]server\.mjs$/.test(process.argv[1] || '')) {
  if (process.env.MK_TEST_PIDFILE) { try { fs.appendFileSync(process.env.MK_TEST_PIDFILE, process.pid + '\n'); } catch { /* best effort */ } }
  if (process.env.MK_TEST_CWDFILE) { try { fs.appendFileSync(process.env.MK_TEST_CWDFILE, JSON.stringify({ pid: process.pid, cwd: process.cwd() }) + '\n'); } catch { /* best effort */ } }
}
