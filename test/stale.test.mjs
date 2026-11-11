// A silent cook goes 'quiet' on the periodic sweep (MONKEY_KITCHEN_STALE_MS, swept every
// MONKEY_KITCHEN_SWEEP_MS): it is not finished, keeps its ticket, and comes back on its next event.
// A silent main thread with no active cook idles the chef and stops a still-cooking order.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startKitchen, sleep } from './helpers/kitchen.mjs';

const STALE = 600, SWEEP = 100;
let k;
before(async () => { k = await startKitchen({ MONKEY_KITCHEN_STALE_MS: String(STALE), MONKEY_KITCHEN_SWEEP_MS: String(SWEEP) }); });
after(async () => { await k?.stop(); });

const LINE = 'monkey-kitchen:line-cook';

test('a silent cook goes quiet (not finished), keeps its ticket across a new order, wakes on its next event and finishes; the chef idles only once no cook is active', { timeout: 20000 }, async () => {
  const s = k.kitchenSession();
  await s.prompt('long order');
  await s.call('tu1', LINE, 'Quiet ticket', 'Quiet prompt');
  await s.start('quiet', LINE);
  await s.ret('tu1', { agentId: 'quiet' });
  await s.start('busy', LINE);

  // Keep "busy" talking while "quiet" and the main thread say nothing, until a sweep marks "quiet".
  const deadline = Date.now() + 8000;
  let st, quiet;
  let i = 0;
  while (Date.now() < deadline) {
    await s.tool('busy', LINE, 'Read', { file_path: `f${i++}.txt` });
    st = await s.get();
    quiet = st.cooks.find(c => c.id === 'quiet');
    if (quiet.status !== 'working') break;
    await sleep(100);
  }
  assert.equal(quiet.status, 'quiet', 'silent cook is quiet');
  assert.ok(!('stale' in quiet), 'no stale flag');
  assert.equal(quiet.endedAt, 0, 'quiet is not finished');
  assert.equal(st.cooks.find(c => c.id === 'busy').status, 'working', 'busy cook untouched');
  assert.equal(st.chef.status, 'working', 'chef not idled while a cook is working');

  // Now "busy" goes silent too: both quiet, main thread long silent. The chef must still not be idled.
  st = await k.until(x => { const ss = x.sessions.find(y => y.id === s.id); return ss.cooks.every(c => c.status === 'quiet') && ss; }, 5000, 50);
  assert.ok(st, 'both cooks quiet');
  await sleep(STALE + 3 * SWEEP);
  st = await s.get();
  assert.equal(st.chef.status, 'working', 'chef not idled while cooks are quiet');
  assert.equal(st.order.status, 'cooking');

  // A new order: the quiet cook stays on the rail with its ticket.
  await s.prompt('second order');
  let c = await s.cook('quiet');
  assert.ok(c, 'quiet cook survives a new order');
  assert.equal(c.status, 'quiet');
  assert.equal(c.ticket, 'Quiet ticket');

  await s.tool('quiet', LINE, 'Edit', { file_path: 'back.txt' });
  c = await s.cook('quiet');
  assert.equal(c.status, 'working', 'back to working on its next event');
  assert.equal(c.tools, 1);

  await s.finish('quiet', LINE, 'quiet report');
  c = await s.cook('quiet');
  assert.equal(c.status, 'done');
  assert.ok(c.endedAt > 0);
  assert.equal(c.report, 'quiet report');
  assert.equal(c.ticket, 'Quiet ticket');

  await s.finish('busy', LINE, 'busy report');
  // No cook active and the main thread silent: the chef idles and the order is stopped.
  st = await k.until(x => { const ss = x.sessions.find(y => y.id === s.id); return ss.chef.status === 'idle' && ss; }, 5000, 50);
  assert.ok(st, 'chef idled once no cook is active');
  assert.equal(st.order.status, 'stopped');
  assert.equal(st.order.text, 'second order');
});
