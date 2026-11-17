// `npm test`: runs every test/*.test.mjs with `node --test`. The files are listed here because a glob on the
// command line is expanded neither by Node 18/20 nor by cmd.exe on Windows. Extra arguments go to node before the
// files, e.g. `npm test -- --test-name-pattern=lock`.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const files = fs.readdirSync(dir).filter(f => f.endsWith('.test.mjs')).sort().map(f => path.join(dir, f));
if (!files.length) { console.error('no test files found in ' + dir); process.exit(1); }

const child = spawn(process.execPath, ['--test', ...process.argv.slice(2), ...files], { stdio: 'inherit' });
child.on('error', e => { console.error(e); process.exit(1); });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
