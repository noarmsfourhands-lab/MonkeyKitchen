// Ordering and lifecycle of orders, the chef and cooks.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startKitchen } from './helpers/kitchen.mjs';

let k;
before(async () => { k = await startKitchen(); });
after(async () => { await k?.stop(); });

const LINE = 'monkey-kitchen:line-cook';

test('a finished cook is not revived by a late PreToolUse', async () => {
  const s = k.kitchenSession();
  await s.prompt();
  await s.start('a1', LINE);
  await s.finish('a1', LINE, 'all done');
  await s.tool('a1', LINE, 'Read', { file_path: 'late.txt' });
  const c = await s.cook('a1');
  assert.equal(c.status, 'done');
  assert.equal(c.tools, 0, 'late tool event not counted');
  assert.equal(c.log.length, 0);
});

test('after a new UserPromptSubmit, a late event for an old agent id does not create a cook', async () => {
  const s = k.kitchenSession();
  await s.prompt('first');
  await s.start('old', LINE);
  await s.finish('old', LINE, 'done');
  await s.prompt('second');
  await s.tool('old', LINE, 'Read', { file_path: 'x' });
  await s.start('old', LINE);
  const st = await s.get();
  assert.equal(st.cooks.find(c => c.id === 'old'), undefined, 'old cook not recreated');
});

test('a cook still working at a new UserPromptSubmit stays on the rail and can still finish', async () => {
  const s = k.kitchenSession();
  await s.prompt('first');
  await s.start('w1', LINE);
  await s.prompt('second');
  let c = await s.cook('w1');
  assert.ok(c, 'working cook kept');
  assert.equal(c.status, 'working');
  await s.tool('w1', LINE, 'Edit', { file_path: 'a.js' });
  await s.finish('w1', LINE, 'finished after the new order');
  c = await s.cook('w1');
  assert.equal(c.status, 'done');
  assert.equal(c.report, 'finished after the new order');
  assert.equal(c.tools, 1);
});

test('a main-thread PreToolUse stamped before the last Stop leaves the chef idle; a later one wakes it', async () => {
  const s = k.kitchenSession();
  const t0 = Date.now();
  await s.prompt('order', { ts: t0 });
  await s.stopTurn({ ts: t0 + 300 });
  await s.tool(null, null, 'Read', { file_path: 'early.txt' }, { ts: t0 + 200 });
  let st = await s.get();
  assert.equal(st.chef.status, 'idle');
  assert.equal(st.order.status, 'served');
  // Within the 1000 ms slack after Stop: still part of the turn that ended.
  await s.tool(null, null, 'Read', { file_path: 'slack.txt' }, { ts: t0 + 300 + 500 });
  st = await s.get();
  assert.equal(st.chef.status, 'idle', 'an event 500 ms after Stop does not wake the chef');
  assert.equal(st.order.status, 'served');
  // Well past the slack: a new piece of work.
  await s.tool(null, null, 'Read', { file_path: 'later.txt' }, { ts: t0 + 300 + 1100 });
  st = await s.get();
  assert.equal(st.chef.status, 'working', 'an event 1100 ms after Stop wakes the chef');
  assert.equal(st.order.status, 'cooking');
});

test('a UserPromptSubmit delivered after the Stop of the same turn leaves the order served and the chef idle', async () => {
  const s = k.kitchenSession();
  const t0 = Date.now();
  await s.stopTurn({ ts: t0 + 100 });
  await s.prompt('quick question', { ts: t0 });
  const st = await s.get();
  assert.ok(st.order, 'order exists');
  assert.equal(st.order.status, 'served');
  assert.equal(st.chef.status, 'idle');
});

test('permission_prompt Notification sets the chef waiting; a main-thread PostToolUse sets it working', async () => {
  const s = k.kitchenSession();
  await s.prompt();
  await s.send('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
  assert.equal((await s.get()).chef.status, 'waiting');
  await s.send('PostToolUse', { tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: 'ls' }, tool_response: { stdout: '' } });
  assert.equal((await s.get()).chef.status, 'working');
});

test('SubagentStop stores the report and sets done; each PreToolUse appends to log (max 20) and counts tools', async () => {
  const s = k.kitchenSession();
  await s.prompt();
  await s.start('a1', LINE);
  for (let i = 0; i < 25; i++) await s.tool('a1', LINE, 'Read', { file_path: `file${i}.txt` });
  let c = await s.cook('a1');
  assert.equal(c.tools, 25);
  assert.equal(c.log.length, 20);
  assert.match(c.log[19].text, /file24\.txt/);
  assert.match(c.log[0].text, /file5\.txt/);
  await s.finish('a1', LINE, 'Report: all 25 files read.');
  c = await s.cook('a1');
  assert.equal(c.status, 'done');
  assert.equal(c.report, 'Report: all 25 files read.');
});

test('PostToolUseFailure for an Agent call marks the cook named by the call failed', async () => {
  const s = k.kitchenSession();
  await s.prompt();
  await s.call('tu1', LINE, 'Ticket one', 'Prompt one');
  await s.start('a1', LINE);
  await s.ret('tu1', { agentId: 'a1' });
  await s.send('PostToolUseFailure', { tool_name: 'Agent', tool_use_id: 'tu1', tool_input: {}, error: 'agent crashed' });
  const c = await s.cook('a1');
  assert.equal(c.status, 'failed');
});

test('PostToolUseFailure for an unpaired Agent call does not fail a cook holding another call\'s ticket', async () => {
  const s = k.kitchenSession();
  await s.prompt();
  await s.call('tu1', LINE, 'Ticket one', 'Prompt one');
  await s.call('tu2', LINE, 'Ticket two', 'Prompt two');
  await s.start('a1', LINE);
  await s.ret('tu1', { agentId: 'a1' });
  await s.send('PostToolUseFailure', { tool_name: 'Agent', tool_use_id: 'tu2', tool_input: {}, error: 'could not start' });
  const a1 = await s.cook('a1');
  assert.equal(a1.status, 'working');
});

test('any PostToolUseFailure increments dropped (main thread, working cook, finished cook)', async () => {
  const s = k.kitchenSession();
  await s.prompt();
  await s.start('a1', LINE);
  await s.start('a2', LINE);
  await s.finish('a2', LINE, 'done');
  await s.send('PostToolUseFailure', { tool_name: 'Bash', tool_use_id: 'f1', tool_input: { command: 'x' }, error: 'boom' });
  assert.equal((await s.get()).dropped, 1);
  await s.send('PostToolUseFailure', { agent_id: 'a1', agent_type: LINE, tool_name: 'Bash', tool_use_id: 'f2', tool_input: {}, error: 'boom' });
  assert.equal((await s.get()).dropped, 2);
  await s.send('PostToolUseFailure', { agent_id: 'a2', agent_type: LINE, tool_name: 'Edit', tool_use_id: 'f3', tool_input: {}, error: 'boom' });
  const st = await s.get();
  assert.equal(st.dropped, 3);
  assert.ok(st.lastDrop, 'lastDrop set');
});

test('a PostToolUseFailure from an agent not on the rail still increments dropped', async () => {
  const s = k.kitchenSession();
  await s.prompt();
  await s.send('PostToolUseFailure', { agent_id: 'never-started', agent_type: LINE, tool_name: 'Bash', tool_use_id: 'f1', tool_input: {}, error: 'boom' });
  let st = await s.get();
  assert.equal(st.dropped, 1);
  assert.equal(st.cooks.find(c => c.id === 'never-started'), undefined, 'no cook created');
  // A cook cleared off the rail by a new order: its failure counts but does not bring it back.
  await s.start('gone', LINE);
  await s.finish('gone', LINE, 'done');
  await s.prompt('next order');
  await s.send('PostToolUseFailure', { agent_id: 'gone', agent_type: LINE, tool_name: 'Edit', tool_use_id: 'f2', tool_input: {}, error: 'boom' });
  st = await s.get();
  assert.equal(st.dropped, 2);
  assert.equal(st.cooks.find(c => c.id === 'gone'), undefined, 'cleared cook not recreated');
});

test('SessionEnd finishes working cooks and serves the order; an earlier-stamped main event does not wake the chef', async () => {
  const s = k.kitchenSession();
  const t0 = Date.now();
  await s.prompt('order', { ts: t0 });
  await s.start('a1', LINE, { ts: t0 + 10 });
  await s.send('SessionEnd', { reason: 'exit' }, { ts: t0 + 100 });
  let st = await s.get();
  assert.equal(st.order.status, 'served');
  assert.equal(st.chef.status, 'idle');
  assert.equal(st.cooks.find(c => c.id === 'a1').status, 'done');
  await s.tool(null, null, 'Read', { file_path: 'x' }, { ts: t0 + 50 });
  await s.send('PostToolUse', { tool_name: 'Read', tool_use_id: 'r1', tool_input: {}, tool_response: {} }, { ts: t0 + 60 });
  st = await s.get();
  assert.equal(st.chef.status, 'idle');
  assert.equal(st.order.status, 'served');
});

test('two sessions do not leak into each other', async () => {
  const A = k.kitchenSession(), B = k.kitchenSession();
  await A.prompt('order for A');
  await B.prompt('order for B');
  await A.call('ta', LINE, 'Ticket A', 'Prompt A');
  await B.call('tb', LINE, 'Ticket B', 'Prompt B');
  await A.start('shared-id', LINE);
  await B.start('shared-id', LINE);
  await B.start('only-b', LINE);
  await A.finish('shared-id', LINE, 'A report');
  await B.send('PostToolUseFailure', { tool_name: 'Bash', tool_use_id: 'f', tool_input: {}, error: 'x' });
  const a = await A.get(), b = await B.get();
  assert.equal(a.order.text, 'order for A');
  assert.equal(b.order.text, 'order for B');
  assert.deepEqual(a.cooks.map(c => c.id).sort(), ['shared-id']);
  assert.deepEqual(b.cooks.map(c => c.id).sort(), ['only-b', 'shared-id']);
  assert.equal(a.cooks[0].status, 'done');
  assert.equal(a.cooks[0].ticket, 'Ticket A');
  const bShared = b.cooks.find(c => c.id === 'shared-id');
  assert.equal(bShared.status, 'working', 'stopping the cook in A does not stop the one in B');
  assert.equal(bShared.ticket, 'Ticket B');
  assert.equal(a.dropped, 0);
  assert.equal(b.dropped, 1);
  assert.ok(!JSON.stringify(a.feed).includes('order for B'), 'A feed has nothing from B');
  assert.ok(!JSON.stringify(b.feed).includes('order for A'), 'B feed has nothing from A');
});
