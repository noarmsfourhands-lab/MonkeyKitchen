#!/usr/bin/env node
// Plays a scripted service through the real hook relay, so you can watch the
// kitchen without spending any tokens:  npm run demo
// It writes a fake transcript to the temp folder so the usage tab has numbers.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'hook.mjs');
const FAST = process.argv.includes('--fast');
const sleep = ms => new Promise(r => setTimeout(r, FAST ? 30 : ms));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monkey-kitchen-demo-'));
const session = 'demo-' + Date.now().toString(36);
const transcript = path.join(dir, session + '.jsonl');
const subDir = path.join(dir, session, 'subagents');
fs.mkdirSync(subDir, { recursive: true });
fs.writeFileSync(transcript, '');

let n = 0;
function bill(file, model, input, output, cacheRead = 0, cacheWrite = 0) {
  const rec = { type: 'assistant', uuid: 'u' + n, message: { id: 'msg_demo_' + n++, model, usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite } } };
  fs.appendFileSync(file, JSON.stringify(rec) + '\n');
}
const agentFile = id => path.join(subDir, `agent-${id}.jsonl`);

function send(event, extra = {}) {
  const payload = { session_id: session, transcript_path: transcript, cwd: path.join(os.homedir(), 'banana-stand'), hook_event_name: event, ...extra };
  spawnSync(process.execPath, [HOOK], { input: JSON.stringify(payload) });
}
const cook = (id, type) => ({ agent_id: id, agent_type: 'monkey-kitchen:' + type });
const call = (type, description) => send('PreToolUse', { tool_name: 'Agent', tool_input: { subagent_type: 'monkey-kitchen:' + type, description } });
const tool = (who, tool_name, tool_input) => send('PreToolUse', { ...who, tool_name, tool_input });

console.log('Playing a demo service. Watch http://localhost:' + (process.env.MONKEY_KITCHEN_PORT || 4747));

send('SessionStart', { source: 'startup' });
send('UserPromptSubmit', { prompt: 'Add a "banana of the day" card to the home page, backed by a new /api/banana endpoint, with tests.' });
bill(transcript, 'claude-fable-5-2', 1800, 420, 21000, 3000);
await sleep(1500);

const prep = cook('a1', 'prep-cook'), run = cook('a2', 'runner');
call('prep-cook', 'Find the home page and API route layout');
call('runner', 'Check the date-fns formatting API');
send('SubagentStart', prep); send('SubagentStart', run);
await sleep(900);
tool(prep, 'Glob', { pattern: 'src/app/**/page.tsx' }); tool(run, 'WebSearch', { query: 'date-fns format tokens' });
await sleep(1300);
tool(prep, 'Read', { file_path: 'src/app/page.tsx' }); tool(run, 'WebFetch', { url: 'https://date-fns.org/docs/format' });
await sleep(1300);
tool(prep, 'Grep', { pattern: 'export async function GET' });
bill(agentFile('a1'), 'claude-haiku-5-5', 14000, 900, 8000); bill(agentFile('a2'), 'claude-haiku-5-5', 9000, 600);
await sleep(1200);
send('SubagentStop', run); send('SubagentStop', prep);
bill(transcript, 'claude-fable-5-2', 600, 350, 26000);
await sleep(1500);

const fe = cook('a3', 'frontend-cook'), be = cook('a4', 'backend-cook');
call('backend-cook', 'Build GET /api/banana returning today\'s banana');
call('frontend-cook', 'Add the BananaCard component to the home page');
send('SubagentStart', be); send('SubagentStart', fe);
await sleep(900);
tool(be, 'Read', { file_path: 'src/app/api/health/route.ts' }); tool(fe, 'Read', { file_path: 'src/app/page.tsx' });
await sleep(1400);
tool(be, 'Write', { file_path: 'src/app/api/banana/route.ts' }); tool(fe, 'Write', { file_path: 'src/components/BananaCard.tsx' });
await sleep(1600);
tool(fe, 'Edit', { file_path: 'src/app/page.tsx' }); tool(be, 'Bash', { command: 'npx tsc --noEmit', description: 'Type check' });
await sleep(1400);
send('PostToolUseFailure', { ...be, tool_name: 'Bash', tool_input: { command: 'npx tsc --noEmit' } });
tool(be, 'Edit', { file_path: 'src/app/api/banana/route.ts' });
bill(agentFile('a3'), 'claude-sonnet-5-5', 22000, 3100, 30000); bill(agentFile('a4'), 'claude-sonnet-5-5', 19000, 2600, 24000);
await sleep(1500);
send('SubagentStop', fe); send('SubagentStop', be);
await sleep(1300);

const taste = cook('a5', 'taster'), wash = cook('a6', 'dishwasher'), guest = { agent_id: 'a7', agent_type: 'Explore' };
call('taster', 'Run the test suite and the build');
call('dishwasher', 'Format the three changed files');
call('Explore', 'Find every mention of banana');
send('SubagentStart', taste); send('SubagentStart', wash); send('SubagentStart', guest);
await sleep(900);
tool(taste, 'Bash', { command: 'npm test', description: 'Run tests' }); tool(wash, 'Bash', { command: 'npx prettier --write src', description: 'Format changed files' });
tool(guest, 'Grep', { pattern: 'banana' });
await sleep(1800);
tool(taste, 'Bash', { command: 'npm run build', description: 'Build' });
bill(agentFile('a5'), 'claude-sonnet-5-5', 12000, 800, 9000); bill(agentFile('a6'), 'claude-haiku-5-5', 6000, 300); bill(agentFile('a7'), 'claude-haiku-5-5', 5000, 400);
await sleep(1500);
send('SubagentStop', wash); send('SubagentStop', guest); send('SubagentStop', taste);
await sleep(1000);

const sous = cook('a8', 'sous-chef'), insp = cook('a9', 'inspector'), scribe = cook('a10', 'scribe'), line = cook('a11', 'line-cook');
call('inspector', 'Review the banana endpoint and card');
call('scribe', 'Document /api/banana in the README');
call('line-cook', 'Add a seed script for banana data');
call('sous-chef', 'Decide how the daily banana should be cached');
for (const c of [insp, scribe, line, sous]) send('SubagentStart', c);
await sleep(900);
tool(insp, 'Bash', { command: 'git diff', description: 'Read the diff' }); tool(scribe, 'Read', { file_path: 'README.md' });
tool(line, 'Write', { file_path: 'scripts/seed-bananas.mjs' }); tool(sous, 'Read', { file_path: 'src/lib/cache.ts' });
await sleep(1800);
tool(scribe, 'Edit', { file_path: 'README.md' }); tool(insp, 'Read', { file_path: 'src/app/api/banana/route.ts' });
bill(agentFile('a8'), 'claude-opus-5-5', 16000, 1900, 12000); bill(agentFile('a9'), 'claude-sonnet-5-5', 15000, 1200, 10000);
bill(agentFile('a10'), 'claude-haiku-5-5', 7000, 900); bill(agentFile('a11'), 'claude-sonnet-5-5', 9000, 1400);
await sleep(1600);
for (const c of [scribe, line, insp, sous]) send('SubagentStop', c);
await sleep(1200);

send('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
await sleep(2500);
send('PreToolUse', { tool_name: 'Read', tool_input: { file_path: 'src/app/api/banana/route.ts' } });
bill(transcript, 'claude-fable-5-2', 900, 700, 31000);
await sleep(1500);
send('Stop');
console.log('Demo finished. Session id: ' + session);
