// Machine turns (hand-backs and notices are not orders), out-of-order cook events, and the waiting state.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startKitchen } from './helpers/kitchen.mjs';

let k;
before(async () => { k = await startKitchen(); });
after(async () => { await k?.stop(); });

const LINE = 'monkey-kitchen:line-cook';
const newOrderLines = st => st.feed.filter(l => /new order/.test(l.text)).length;

const MACHINE = {
  'agent-message hand-back': '<agent-message from="x">\n[Subagent hand-back]\nThe cook finished: all tests pass.\n</agent-message>',
  'task-notification': '<task-notification>\n<task-id>abc</task-id>\n<status>completed</status>\n</task-notification>',
  'system-reminder': '<system-reminder>\nA background task finished.\n</system-reminder>',
  'SYSTEM NOTIFICATION': '[SYSTEM NOTIFICATION - NOT USER INPUT] The background command exited with code 0.',
};

for (const [name, text] of Object.entries(MACHINE)) {
  test(`a machine turn (${name}) is not a new order: order and finished cooks kept, chef and order woken, next Stop serves it`, async () => {
    const s = k.kitchenSession();
    await s.prompt('the real order');
    await s.call('tu1', LINE, 'Real ticket', 'Real prompt');
    await s.start('a1', LINE);
    await s.ret('tu1', { agentId: 'a1' });
    await s.finish('a1', LINE, 'cook report');
    await s.stopTurn();
    let st = await s.get();
    assert.equal(st.order.status, 'served', 'precondition');
    const lines = newOrderLines(st);
    assert.equal(lines, 1);

    await s.prompt(text);
    st = await s.get();
    assert.equal(st.order.text, 'the real order', 'order text kept');
    assert.equal(st.order.status, 'cooking');
    assert.equal(st.chef.status, 'working');
    const a1 = st.cooks.find(c => c.id === 'a1');
    assert.ok(a1, 'finished cook kept on the rail');
    assert.equal(a1.status, 'done');
    assert.equal(a1.ticket, 'Real ticket');
    assert.equal(newOrderLines(st), lines, 'no "new order" feed line');

    await s.stopTurn();
    st = await s.get();
    assert.equal(st.order.status, 'served');
    assert.equal(st.chef.status, 'idle');

    // A real prompt afterwards is a new order and clears finished cooks.
    await s.prompt('a second real order');
    st = await s.get();
    assert.equal(st.order.text, 'a second real order');
    assert.equal(st.order.status, 'cooking');
    assert.equal(st.cooks.find(c => c.id === 'a1'), undefined, 'finished cook cleared');
    assert.equal(newOrderLines(st), lines + 1);
  });
}

test('a SubagentStop that arrives before its SubagentStart: the cook ends done with its report and its own ticket; later events change nothing', async () => {
  const s = k.kitchenSession();
  await s.prompt('order');
  await s.call('tu1', LINE, 'Ticket one', 'Prompt one');
  await s.call('tu2', LINE, 'Ticket two', 'Prompt two');
  // a2 (tu2's cook) reports first; by guesswork it would take tu1's ticket.
  await s.finish('a2', LINE, 'report from a2');
  await s.start('a2', LINE);
  await s.start('a1', LINE);
  await s.ret('tu2', { agentId: 'a2' });
  await s.ret('tu1', { agentId: 'a1' });
  const a2 = await s.cook('a2');
  assert.ok(a2, 'a2 on the rail');
  assert.equal(a2.status, 'done');
  assert.equal(a2.report, 'report from a2');
  assert.equal(a2.ticket, 'Ticket two');
  assert.equal(a2.prompt, 'Prompt two');
  const a1 = await s.cook('a1');
  assert.equal(a1.status, 'working');
  assert.equal(a1.ticket, 'Ticket one');

  const before = JSON.stringify(await s.cook('a2'));
  await s.tool('a2', LINE, 'Read', { file_path: 'late.txt' }, undefined);
  await s.send('PreToolUse', { agent_id: 'a2', agent_type: LINE, tool_name: 'Edit', tool_input: { file_path: 'x' }, effort: { level: 'high' } });
  await s.send('PostToolUse', { agent_id: 'a2', agent_type: LINE, tool_name: 'Edit', tool_input: {}, tool_response: {} });
  await s.start('a2', LINE);
  assert.equal(JSON.stringify(await s.cook('a2')), before, 'late events for a finished cook change nothing');
});

test('a SubagentStop alone (no Start, no tool events) still puts the cook on the rail as done', async () => {
  const s = k.kitchenSession();
  await s.prompt('order');
  await s.call('tu1', LINE, 'Lone ticket', 'Lone prompt');
  await s.finish('lone', LINE, 'lone report');
  await s.ret('tu1', { agentId: 'lone' });
  const c = await s.cook('lone');
  assert.ok(c);
  assert.equal(c.status, 'done');
  assert.equal(c.report, 'lone report');
  assert.equal(c.ticket, 'Lone ticket');
});

test('after Stop, a permission Notification sets the chef waiting; a later cook tool event restores it to idle', async () => {
  const s = k.kitchenSession();
  const t0 = Date.now();
  await s.prompt('order', { ts: t0 });
  await s.start('a1', LINE, { ts: t0 + 10 });
  await s.stopTurn({ ts: t0 + 100 });
  // The cook's tool call is what raises the permission prompt (PreToolUse runs just before it).
  await s.tool('a1', LINE, 'Bash', { command: 'rm -rf build' }, { ts: t0 + 150 });
  await s.send('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission' }, { ts: t0 + 200 });
  let st = await s.get();
  assert.equal(st.chef.status, 'waiting');
  // A cook event stamped before the Notification (delivered late) leaves it waiting.
  await s.send('PostToolUse', { agent_id: 'a1', agent_type: LINE, tool_name: 'Read', tool_use_id: 'r0', tool_input: {}, tool_response: {} }, { ts: t0 + 180 });
  assert.equal((await s.get()).chef.status, 'waiting', 'an earlier-stamped event leaves it waiting');
  await s.tool('a1', LINE, 'Read', { file_path: 'later.txt' }, { ts: t0 + 300 });
  st = await s.get();
  assert.equal(st.chef.status, 'idle', 'restored to idle (the turn had ended)');
  assert.equal(st.order.status, 'served');
});

test('mid-turn, a SubagentStop stamped before the Notification leaves the chef waiting', async () => {
  const s = k.kitchenSession();
  const t0 = Date.now();
  await s.prompt('order', { ts: t0 });
  await s.start('a1', LINE, { ts: t0 + 10 });
  await s.tool(null, null, 'Grep', { pattern: 'needle' }, { ts: t0 + 20 });
  let st = await s.get();
  const activity = st.chef.activity;
  assert.match(activity, /needle/, 'precondition');
  await s.tool('a1', LINE, 'Bash', { command: 'deploy' }, { ts: t0 + 30 }); // the cook asks
  await s.send('Notification', { notification_type: 'permission_prompt', message: 'Needs you' }, { ts: t0 + 50 });
  assert.equal((await s.get()).chef.status, 'waiting');
  await s.finish('a1', LINE, 'done', { ts: t0 + 40 });
  st = await s.get();
  assert.equal(st.chef.status, 'waiting', 'a SubagentStop stamped before the Notification leaves it waiting');
});

test('mid-turn, a SubagentStop stamped after the Notification restores working with the previous activity', async () => {
  const s = k.kitchenSession();
  const t0 = Date.now();
  await s.prompt('order', { ts: t0 });
  await s.start('a1', LINE, { ts: t0 + 10 });
  await s.tool(null, null, 'Grep', { pattern: 'needle' }, { ts: t0 + 20 });
  const activity = (await s.get()).chef.activity;
  await s.tool('a1', LINE, 'Bash', { command: 'deploy' }, { ts: t0 + 30 }); // the cook asks
  await s.send('Notification', { notification_type: 'permission_prompt', message: 'Needs you' }, { ts: t0 + 50 });
  assert.equal((await s.get()).chef.status, 'waiting');
  await s.finish('a1', LINE, 'done', { ts: t0 + 60 });
  const st = await s.get();
  assert.equal(st.chef.status, 'working');
  assert.equal(st.chef.activity, activity);
  assert.equal(st.order.status, 'cooking');
});
