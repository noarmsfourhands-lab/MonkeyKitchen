// Pairing of tickets (Agent calls) to cooks (subagents).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startKitchen } from './helpers/kitchen.mjs';

let k;
before(async () => { k = await startKitchen(); });
after(async () => { await k?.stop(); });

const TASTER = 'monkey-kitchen:taster';

test('Agent call, then SubagentStart, then PostToolUse gives the cook the ticket and prompt', async () => {
  const s = k.kitchenSession();
  await s.prompt('make soup');
  await s.call('tu1', TASTER, 'Taste the soup', 'Taste the soup and report the salt level.');
  await s.start('a1', TASTER);
  await s.ret('tu1', { agentId: 'a1' });
  const c = await s.cook('a1');
  assert.ok(c, 'cook a1 is on the rail');
  assert.equal(c.ticket, 'Taste the soup');
  assert.equal(c.prompt, 'Taste the soup and report the salt level.');
  assert.equal(c.role, 'taster');
  assert.equal(c.status, 'working');
});

for (const retOrder of [['tu1', 'tu2', 'tu3'], ['tu3', 'tu1', 'tu2']]) {
  test(`three cooks of one role started out of call order end with the right tickets (returns ${retOrder.join(',')})`, async () => {
    const s = k.kitchenSession();
    await s.prompt('three tastings');
    await s.call('tu1', TASTER, 'Ticket one', 'Prompt one');
    await s.call('tu2', TASTER, 'Ticket two', 'Prompt two');
    await s.call('tu3', TASTER, 'Ticket three', 'Prompt three');
    // Cooks clock in in a different order from the calls.
    await s.start('a3', TASTER);
    await s.start('a1', TASTER);
    await s.start('a2', TASTER);
    const agentOf = { tu1: 'a1', tu2: 'a2', tu3: 'a3' };
    for (const tu of retOrder) await s.ret(tu, { agentId: agentOf[tu] });
    const want = { a1: ['Ticket one', 'Prompt one'], a2: ['Ticket two', 'Prompt two'], a3: ['Ticket three', 'Prompt three'] };
    for (const [id, [ticket, prompt]] of Object.entries(want)) {
      const c = await s.cook(id);
      assert.ok(c, `cook ${id} exists`);
      assert.equal(c.ticket, ticket, `${id} ticket`);
      assert.equal(c.prompt, prompt, `${id} prompt`);
    }
  });
}

test('PostToolUse arriving before PreToolUse (cook already started) still pairs', async () => {
  const s = k.kitchenSession();
  await s.prompt('order');
  await s.start('a1', TASTER);
  await s.ret('tu1', { agentId: 'a1' });
  await s.call('tu1', TASTER, 'Late call ticket', 'Late call prompt');
  const c = await s.cook('a1');
  assert.equal(c.ticket, 'Late call ticket');
  assert.equal(c.prompt, 'Late call prompt');
});

test('PostToolUse arriving before PreToolUse and before SubagentStart still pairs', async () => {
  const s = k.kitchenSession();
  await s.prompt('order');
  await s.ret('tu1', { agentId: 'a1' });
  await s.call('tu1', TASTER, 'Reordered ticket', 'Reordered prompt');
  await s.start('a1', TASTER);
  const c = await s.cook('a1');
  assert.equal(c.ticket, 'Reordered ticket');
  assert.equal(c.prompt, 'Reordered prompt');
});

test('PostToolUse before PreToolUse pairs correctly with two same-role cooks waiting', async () => {
  const s = k.kitchenSession();
  await s.prompt('order');
  await s.start('a1', TASTER);
  await s.start('a2', TASTER);
  await s.ret('tu2', { agentId: 'a2' }); // response for the second call beats its own PreToolUse
  await s.call('tu2', TASTER, 'Second ticket', 'Second prompt');
  await s.call('tu1', TASTER, 'First ticket', 'First prompt');
  await s.ret('tu1', { agentId: 'a1' });
  const a1 = await s.cook('a1'), a2 = await s.cook('a2');
  assert.equal(a1.ticket, 'First ticket');
  assert.equal(a1.prompt, 'First prompt');
  assert.equal(a2.ticket, 'Second ticket');
  assert.equal(a2.prompt, 'Second prompt');
});

test('PostToolUse arriving before the cook\'s SubagentStart still pairs', async () => {
  const s = k.kitchenSession();
  await s.prompt('order');
  await s.call('tu1', TASTER, 'First ticket', 'First prompt');
  await s.call('tu2', TASTER, 'Second ticket', 'Second prompt');
  // tu2's cook is named before it clocks in; a1 then clocks in for tu1.
  await s.ret('tu2', { agentId: 'a2' });
  await s.start('a2', TASTER);
  await s.start('a1', TASTER);
  await s.ret('tu1', { agentId: 'a1' });
  const a1 = await s.cook('a1'), a2 = await s.cook('a2');
  assert.equal(a2.ticket, 'Second ticket');
  assert.equal(a2.prompt, 'Second prompt');
  assert.equal(a1.ticket, 'First ticket');
  assert.equal(a1.prompt, 'First prompt');
});

test('tool_response given as a JSON string is handled like an object', async () => {
  const s = k.kitchenSession();
  await s.prompt('order');
  await s.call('tu1', TASTER, 'One', 'P one');
  await s.call('tu2', TASTER, 'Two', 'P two');
  await s.start('a2', TASTER);
  await s.start('a1', TASTER);
  await s.ret('tu1', JSON.stringify({ agentId: 'a1', resolvedModel: 'claude-sonnet-5-0' }));
  await s.ret('tu2', JSON.stringify({ agentId: 'a2' }));
  const a1 = await s.cook('a1'), a2 = await s.cook('a2');
  assert.equal(a1.ticket, 'One');
  assert.equal(a1.prompt, 'P one');
  assert.equal(a1.model, 'claude-sonnet-5-0');
  assert.equal(a2.ticket, 'Two');
  assert.equal(a2.prompt, 'P two');
});

test('tool_response.resolvedModel ends up as the cook\'s model', async () => {
  const s = k.kitchenSession();
  await s.prompt('order');
  await s.call('tu1', TASTER, 'Ticket', 'Prompt', undefined, { model: 'haiku' });
  await s.start('a1', TASTER);
  await s.ret('tu1', { agentId: 'a1', resolvedModel: 'claude-haiku-5-5' });
  assert.equal((await s.cook('a1')).model, 'claude-haiku-5-5');

  // Response before the cook clocks in: the model must still land on it.
  await s.call('tu2', TASTER, 'Ticket 2', 'Prompt 2');
  await s.ret('tu2', { agentId: 'a2', resolvedModel: 'claude-opus-5-5' });
  await s.start('a2', TASTER);
  assert.equal((await s.cook('a2')).model, 'claude-opus-5-5');
});

test('plugin role maps to its short name; unknown types become stagiaire and keep agentType', async () => {
  const s = k.kitchenSession();
  await s.prompt('order');
  await s.start('cdp', 'monkey-kitchen:chef-de-partie');
  await s.start('ex', 'Explore');
  const cdp = await s.cook('cdp'), ex = await s.cook('ex');
  assert.equal(cdp.role, 'chef-de-partie');
  assert.equal(cdp.agentType, 'monkey-kitchen:chef-de-partie');
  assert.equal(ex.role, 'stagiaire');
  assert.equal(ex.agentType, 'Explore');
});
