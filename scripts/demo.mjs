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
const call = (type, description, prompt) => send('PreToolUse', { tool_name: 'Agent', tool_input: { subagent_type: 'monkey-kitchen:' + type, description, prompt } });
const REPORT = {
  a1: 'The home page is src/app/page.tsx and API routes live under src/app/api/<name>/route.ts, each exporting async GET/POST handlers. There is already a health route to copy from.',
  a2: 'date-fns format uses Unicode tokens: yyyy-MM-dd for ISO dates, EEEE for the weekday name and do for ordinals. Avoid YYYY and DD, which mean week-year and day-of-year.',
  a3: 'Added BananaCard in src/components/BananaCard.tsx and mounted it on the home page above the fold. It fetches /api/banana on the server and shows a skeleton while loading.',
  a4: 'GET /api/banana now returns { name, ripeness, emoji } picked by day of year, with a 404 for an empty list. The first type check failed on the response type, fixed in the second edit.',
  a5: 'All 42 tests pass and the production build succeeds with no warnings. The new banana route is covered by two tests, the happy path and the empty list.',
  a6: 'Formatted the three changed files with prettier; two needed trailing-comma fixes and the third was already clean.',
  a7: 'Found 9 mentions of banana: the new route, the card, two tests, the seed script and four in docs. Nothing else references it.',
  a8: 'Recommend caching the daily banana in memory keyed by date with a one-hour revalidate. It is cheap, survives restarts fine, and needs no external store for a single-value endpoint.',
  a9: 'The endpoint and card look correct. Two nits: the card has no alt text on the emoji, and the route should return a Cache-Control header. No blocking issues found.',
  a10: 'Documented GET /api/banana in the README with the response shape, an example request and the caching behaviour.',
  a11: 'Added scripts/seed-bananas.mjs, which fills the banana list with twelve entries and is safe to run twice.',
  a12: 'Cache decision confirmed: wrapped the lookup in a date-keyed memo with a one-hour expiry. Wrote it in src/lib/cache.ts and the route now reads from it.',
};
const stop = c => send('SubagentStop', { ...c, last_assistant_message: REPORT[c.agent_id] });
const tool = (who, tool_name, tool_input) => send('PreToolUse', { ...who, tool_name, tool_input });

console.log('Playing a demo service. Watch http://localhost:' + (process.env.MONKEY_KITCHEN_PORT || 4747));

send('SessionStart', { source: 'startup' });
send('UserPromptSubmit', { prompt: 'Add a "banana of the day" card to the home page, backed by a new /api/banana endpoint, with tests.' });
bill(transcript, 'claude-fable-5-2', 1800, 420, 21000, 3000);
await sleep(1500);

const prep = cook('a1', 'prep-cook'), run = cook('a2', 'runner');
call('prep-cook', 'Find the home page and API route layout', 'Locate the home page component and see how API routes are organised in this Next.js app. Report the file paths and the export style of an existing route handler so the new one can match it.');
call('runner', 'Check the date-fns formatting API', 'Look up the date-fns format function and confirm which tokens print the weekday name and an ISO date. We need the exact token strings, and please flag any common mistakes with year and day tokens.');
send('SubagentStart', prep); send('SubagentStart', run);
await sleep(900);
tool(prep, 'Glob', { pattern: 'src/app/**/page.tsx' }); tool(run, 'WebSearch', { query: 'date-fns format tokens' });
await sleep(1300);
tool(prep, 'Read', { file_path: 'src/app/page.tsx' }); tool(run, 'WebFetch', { url: 'https://date-fns.org/docs/format' });
await sleep(1300);
tool(prep, 'Grep', { pattern: 'export async function GET' });
bill(agentFile('a1'), 'claude-opus-5-5', 14000, 900, 8000); bill(agentFile('a2'), 'claude-opus-5-5', 9000, 600);
await sleep(1200);
stop(run); stop(prep);
bill(transcript, 'claude-fable-5-2', 600, 350, 26000);
await sleep(1500);

const fe = cook('a3', 'frontend-cook'), be = cook('a4', 'backend-cook');
call('backend-cook', 'Build GET /api/banana returning today\'s banana', 'Create src/app/api/banana/route.ts exporting an async GET handler. It should return JSON with name, ripeness and emoji for today, chosen deterministically from a small list by day of year. Mirror the style of the existing health route, return a 404 with an error body if the list is empty, and make sure it passes the TypeScript type check. Do not touch the home page; the Pastry Chef is building the card that will call this endpoint at the same time.');
call('frontend-cook', 'Add the BananaCard component to the home page', 'Build a BananaCard component in src/components and render it near the top of the home page. It should read from /api/banana, show the emoji large with the name and ripeness beneath, and display a skeleton while loading. Keep the styling consistent with the existing cards and make sure it works at phone width.');
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
bill(agentFile('a3'), 'claude-opus-5-5', 22000, 3100, 30000); bill(agentFile('a4'), 'claude-opus-5-5', 19000, 2600, 24000);
await sleep(1500);
stop(fe); stop(be);
await sleep(1300);

const taste = cook('a5', 'taster'), wash = cook('a6', 'dishwasher'), guest = { agent_id: 'a7', agent_type: 'Explore' };
call('taster', 'Run the test suite and the build', 'Run the full test suite and then a production build. Report the number of passing and failing tests, any build warnings, and whether the new banana route is covered by a test. Do not modify any source files.');
call('dishwasher', 'Format the three changed files', 'Run prettier on the three files changed today and nothing else. Tell me which ones actually changed on disk.');
call('Explore', 'Find every mention of banana', 'Search the whole repository for the word banana in code, tests and docs. List each file with the line count of matches and say whether anything outside the new feature refers to it.');
send('SubagentStart', taste); send('SubagentStart', wash); send('SubagentStart', guest);
await sleep(900);
tool(taste, 'Bash', { command: 'npm test', description: 'Run tests' }); tool(wash, 'Bash', { command: 'npx prettier --write src', description: 'Format changed files' });
tool(guest, 'Grep', { pattern: 'banana' });
await sleep(1800);
tool(taste, 'Bash', { command: 'npm run build', description: 'Build' });
bill(agentFile('a5'), 'claude-opus-5-5', 12000, 800, 9000); bill(agentFile('a6'), 'claude-opus-5-5', 6000, 300); bill(agentFile('a7'), 'claude-haiku-5-5', 5000, 400);
await sleep(1500);
stop(wash); stop(guest); stop(taste);
await sleep(1000);

const sous = cook('a8', 'sous-chef'), insp = cook('a9', 'inspector'), scribe = cook('a10', 'scribe'), line = cook('a11', 'line-cook'), cdp = cook('a12', 'chef-de-partie');
call('inspector', 'Review the banana endpoint and card', 'Review the new banana endpoint and the BananaCard component for correctness, accessibility and caching headers. Read the diff first, then the two files in full. Rank any findings by severity and say plainly whether anything blocks shipping. Remember that the endpoint is public, so check how it behaves with unexpected query strings and with an empty banana list, and check that the card handles a failed request without leaving a spinner on screen forever.');
call('scribe', 'Document /api/banana in the README', 'Add a short section to the README describing GET /api/banana: the response shape, one example request and what the daily choice is based on. Keep the tone consistent with the existing sections.');
call('line-cook', 'Add a seed script for banana data', 'Write scripts/seed-bananas.mjs that fills the banana list with about twelve entries, each with a name, ripeness and emoji. It must be safe to run more than once without creating duplicates.');
call('sous-chef', 'Decide how the daily banana should be cached', 'Decide how the daily banana should be cached. Options are no cache, an in-memory memo keyed by date, or framework-level revalidation. Weigh simplicity against freshness, since the answer only changes once a day, and recommend one with a short reason. Then outline the change so the Chef de Partie can carry it out.');
call('chef-de-partie', 'Implement the cache the Sous Chef chose', 'Implement the date-keyed in-memory cache for the daily banana in src/lib/cache.ts, with a one-hour expiry, and make the banana route read through it. Keep the public behaviour of the endpoint unchanged.');
for (const c of [insp, scribe, line, sous, cdp]) send('SubagentStart', c);
await sleep(900);
tool(insp, 'Bash', { command: 'git diff', description: 'Read the diff' }); tool(scribe, 'Read', { file_path: 'README.md' });
tool(line, 'Write', { file_path: 'scripts/seed-bananas.mjs' }); tool(sous, 'Read', { file_path: 'src/lib/cache.ts' });
tool(cdp, 'Read', { file_path: 'src/lib/cache.ts' });
await sleep(1800);
tool(scribe, 'Edit', { file_path: 'README.md' }); tool(insp, 'Read', { file_path: 'src/app/api/banana/route.ts' });
tool(cdp, 'Edit', { file_path: 'src/lib/cache.ts' });
bill(agentFile('a8'), 'claude-opus-5-5', 16000, 1900, 12000); bill(agentFile('a9'), 'claude-opus-5-5', 15000, 1200, 10000);
bill(agentFile('a10'), 'claude-opus-5-5', 7000, 900); bill(agentFile('a11'), 'claude-opus-5-5', 9000, 1400); bill(agentFile('a12'), 'claude-opus-5-5', 11000, 1500, 9000);
await sleep(1600);
for (const c of [scribe, line, insp, sous, cdp]) stop(c);
await sleep(1200);

send('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
await sleep(2500);
send('PreToolUse', { tool_name: 'Read', tool_input: { file_path: 'src/app/api/banana/route.ts' } });
bill(transcript, 'claude-fable-5-2', 900, 700, 31000);
await sleep(1500);
send('Stop');
console.log('Demo finished. Session id: ' + session);
