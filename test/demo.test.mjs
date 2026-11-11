// scripts/demo.mjs --fast against a test server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startKitchen, runNode, DEMO, tempDir, rmDir } from './helpers/kitchen.mjs';

let k;
let dir;
before(async () => { k = await startKitchen(); dir = tempDir('mk-demo-'); });
after(async () => { await k?.stop(); rmDir(dir); });

test('demo --fast ends served, chef idle, every cook done with ticket, prompt, report, tier and effort, usage tiers present', { timeout: 50000 }, async () => {
  // Point the demo's temp transcript at a folder we delete afterwards.
  const r = await runNode([DEMO, '--fast'], { env: { MONKEY_KITCHEN_PORT: String(k.port), TEMP: dir, TMP: dir, TMPDIR: dir }, timeout: 45000 });
  assert.equal(r.code, 0, r.stderr);
  const sid = r.stdout.match(/Session id: (\S+)/)?.[1];
  assert.ok(sid, 'demo printed its session id');
  // Tiers are stamped on the cooks when the transcripts are scanned, shortly after the last events.
  const s = await k.until(st => { const x = st.sessions.find(y => y.id === sid); return x?.usage?.tiers?.length && x.cooks.length && x.cooks.every(c => c.tier) && x; }, 8000);
  assert.ok(s, 'session with usage in /state');
  assert.equal(s.order?.status, 'served');
  assert.equal(s.chef.status, 'idle');
  assert.equal(s.cooks.length, 12, 'all twelve demo cooks on the rail');
  for (const c of s.cooks) {
    assert.equal(c.status, 'done', `${c.id} done`);
    assert.ok(c.ticket, `${c.id} has a ticket`);
    assert.ok(c.prompt, `${c.id} has a prompt`);
    assert.ok(c.report, `${c.id} has a report`);
    assert.ok(c.tier, `${c.id} has a tier`);
    assert.equal(typeof c.effort, 'string');
    assert.ok(c.effort, `${c.id} has an effort`);
  }
  const cdp = s.cooks.find(c => c.agentType === 'monkey-kitchen:chef-de-partie');
  assert.ok(cdp, 'chef-de-partie cook present');
  assert.equal(cdp.role, 'chef-de-partie');
  assert.equal(cdp.effort, 'high');
  assert.equal(s.cooks.find(c => c.agentType === 'Explore')?.role, 'stagiaire');
  const tiers = s.usage.tiers.map(t => t.tier);
  for (const t of ['fable', 'opus', 'haiku']) assert.ok(tiers.includes(t), `tier ${t} present`);
});
