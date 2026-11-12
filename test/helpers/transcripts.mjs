// Synthetic Claude Code transcripts for the read-back tests: the main JSONL, and per cook
// subagents/agent-<id>.jsonl plus agent-<id>.meta.json. Shapes follow what Claude Code writes; all text is made up.

import fs from 'node:fs';
import path from 'node:path';

export const iso = ms => new Date(ms).toISOString();
export const userRec = (text, at, extra = {}) => ({ type: 'user', isSidechain: false, timestamp: iso(at), message: { role: 'user', content: text }, ...extra });
export const toolResult = (id, at) => ({ type: 'user', isSidechain: false, timestamp: iso(at), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
let n = 0;
// One assistant response: each block is written as its own record, all sharing the message id.
export function assistantRecs(blocks, at, { model = 'claude-fable-5-2', sidechain = false } = {}) {
  const id = 'msg_' + n++;
  const hasTool = blocks.some(b => b.type === 'tool_use');
  return blocks.map(b => ({
    type: 'assistant', isSidechain: sidechain, timestamp: iso(at),
    message: { id, model, role: 'assistant', content: [b], stop_reason: hasTool ? 'tool_use' : 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } },
  }));
}
export const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });
export const text = t => ({ type: 'text', text: t });

export function writeJsonl(file, recs) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, recs.map(r => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n');
}

export const subDir = main => path.join(main.replace(/\.jsonl$/, ''), 'subagents');
export function writeCook(main, id, recs, meta) {
  const dir = subDir(main);
  writeJsonl(path.join(dir, `agent-${id}.jsonl`), recs);
  if (meta !== undefined) fs.writeFileSync(path.join(dir, `agent-${id}.meta.json`), typeof meta === 'string' ? meta : JSON.stringify(meta));
  return path.join(dir, `agent-${id}.jsonl`);
}
// Backdate a file: a cook transcript untouched for 30 s or more counts as settled.
export function age(file, ms) { const t = new Date(Date.now() - ms); fs.utimesSync(file, t, t); }

// The standard scene: an earlier order, the current one (behind a system reminder), two Agent calls, then records
// that are not orders (a meta record, a task notification, tool results). Cook c1 has finished, c2 is still running,
// c0 started before the current order.
export function kitchenScene(dir, name = 'main', { mainSettled = false } = {}) {
  const main = path.join(dir, `${name}.jsonl`);
  const T = Date.now() - 10 * 60 * 1000;
  const recs = [
    userRec('an earlier order', T - 10 * 60 * 1000),
    ...assistantRecs([text('earlier answer')], T - 9 * 60 * 1000),
    userRec('<system-reminder>\nnoise\n</system-reminder>\nMake the soup hotter', T, { origin: { kind: 'human' } }),
    ...assistantRecs([toolUse('toolu_1', 'Agent', { subagent_type: 'monkey-kitchen:line-cook', description: 'Heat the soup', prompt: 'Full prompt for the line cook.' })], T + 1000),
    ...assistantRecs([toolUse('toolu_2', 'Agent', { subagent_type: 'monkey-kitchen:taster', description: 'Taste the soup', prompt: 'Full prompt for the taster.' })], T + 2000),
    userRec('Skill text the user never typed', T + 3000, { isMeta: true }),
    userRec('<task-notification>\n<task-id>x</task-id>\n</task-notification>', T + 4000),
    toolResult('toolu_1', T + 5000),
  ];
  if (mainSettled) recs.push(...assistantRecs([text('All done.')], T + 6000));
  writeJsonl(main, recs);
  const c0 = writeCook(main, 'c0', [userRec('old cook prompt', T - 60 * 1000, { isSidechain: true })], { agentType: 'monkey-kitchen:runner', description: 'Old errand', toolUseId: 'toolu_0' });
  const c1 = writeCook(main, 'c1', [
    userRec('Prompt as the cook saw it', T + 1500, { isSidechain: true }),
    ...assistantRecs([toolUse('t1', 'Read', { file_path: 'src/soup.js' })], T + 2000, { model: 'claude-opus-5-5', sidechain: true }),
    toolResult('t1', T + 2100),
    ...assistantRecs([toolUse('t2', 'Edit', { file_path: 'src/stove.js' })], T + 3000, { model: 'claude-opus-5-5', sidechain: true }),
    toolResult('t2', T + 3100),
    ...assistantRecs([text('The soup is'), text('now hot.')], T + 4000, { model: 'claude-opus-5-5', sidechain: true }),
  ], { agentType: 'monkey-kitchen:line-cook', description: 'Heat the soup', toolUseId: 'toolu_1', finished: true });
  const c2 = writeCook(main, 'c2', [
    userRec('Taster prompt as seen', T + 2500, { isSidechain: true }),
    ...assistantRecs([toolUse('t3', 'Bash', { command: 'npm test', description: 'Run the tests' })], T + 3000, { model: 'claude-sonnet-5-5', sidechain: true }),
  ], { agentType: 'monkey-kitchen:taster', description: 'Taste the soup', toolUseId: 'toolu_2' });
  age(c0, 5 * 60 * 1000);
  age(c1, 5 * 60 * 1000);
  if (mainSettled) age(main, 5 * 60 * 1000);
  return { main, T, c0, c1, c2 };
}
