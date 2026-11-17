// Loaded through NODE_OPTIONS by the hook tests: a kitchen server (started by hook.mjs) notes that it was started
// (one line in MK_TEST_STARTFILE) and then dies at once, as a server that cannot start would. Other processes are
// left alone. It records no pid: the process is gone at once, and a cleanup that killed a recorded pid could hit
// whatever process the OS gives that pid next.
import fs from 'node:fs';

if (/server[\\/]server\.mjs$/.test(process.argv[1] || '')) {
  if (process.env.MK_TEST_STARTFILE) { try { fs.appendFileSync(process.env.MK_TEST_STARTFILE, 'started\n'); } catch { /* best effort */ } }
  process.exit(1);
}
