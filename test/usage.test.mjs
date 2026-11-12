// Token usage from transcripts (server/usage.mjs), plus one end-to-end check through the server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { UsageMeter } from '../server/usage.mjs';
import { startKitchen, tempDir, rmDir, ROOT } from './helpers/kitchen.mjs';

const PRICING = JSON.parse(fs.readFileSync(path.join(ROOT, 'server', 'pricing.json'), 'utf8'));
// The card for a model id per pricing.json: longest matching prefix in models, else the tier's rate.
const tierOfId = id => /fable|mythos/.test(id) ? 'fable' : /opus/.test(id) ? 'opus' : /sonnet/.test(id) ? 'sonnet' : /haiku/.test(id) ? 'haiku' : null;
const cardFor = id => {
  const hit = Object.keys(PRICING.models).filter(p => id.toLowerCase().startsWith(p.toLowerCase())).sort((a, b) => b.length - a.length)[0];
  return hit ? PRICING.models[hit] : PRICING.tiers[tierOfId(id)];
};
// Cost at a card; t.cacheWrite (from cache_creation_input_tokens alone) is a 5-minute write.
const cost = (card, t, fast = false) => ((t.input || 0) * card.input + (t.output || 0) * card.output + (t.cacheRead || 0) * card.cacheRead +
  ((t.cacheWrite5m ?? t.cacheWrite) || 0) * card.cacheWrite5m + (t.cacheWrite1h || 0) * card.cacheWrite1h) / 1e6 * (fast ? card.fast || 1 : 1);
const price = (model, t) => cost(cardFor(model), t);
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} != ${b}`);

let dir;
let k;
before(async () => { dir = tempDir('mk-usage-'); k = await startKitchen(); });
after(async () => { await k?.stop(); rmDir(dir); });

let n = 0;
const rec = (id, model, input, output, cacheRead = 0, cacheWrite = 0) => JSON.stringify({
  type: 'assistant', uuid: 'u' + n++, message: { id, model, usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite } },
}) + '\n';
const newTranscript = name => { const f = path.join(dir, name + '.jsonl'); fs.writeFileSync(f, ''); return f; };
const tierRow = (u, tier) => u.tiers.find(t => t.tier === tier);

test('records sharing a message id count once, with the last record\'s values', async () => {
  const f = newTranscript('dup');
  fs.appendFileSync(f, rec('m1', 'claude-opus-5-5', 100, 1) + rec('m1', 'claude-opus-5-5', 100, 50, 7, 3));
  const u = await new UsageMeter(f).scan();
  const o = tierRow(u, 'opus');
  assert.deepEqual({ input: o.input, output: o.output, cacheRead: o.cacheRead, cacheWrite: o.cacheWrite }, { input: 100, output: 50, cacheRead: 7, cacheWrite: 3 });
  assert.equal(u.total.input, 100);
  assert.equal(u.total.output, 50);
});

test('a later record for the same message id, in a later scan, replaces the earlier one', async () => {
  const f = newTranscript('later');
  const m = new UsageMeter(f);
  fs.appendFileSync(f, rec('m1', 'claude-sonnet-5-0', 10, 5) + rec('m2', 'claude-sonnet-5-0', 1, 1));
  let u = await m.scan();
  assert.equal(tierRow(u, 'sonnet').output, 6);
  fs.appendFileSync(f, rec('m1', 'claude-sonnet-5-0', 10, 70));
  u = await m.scan();
  assert.equal(tierRow(u, 'sonnet').output, 71);
  assert.equal(tierRow(u, 'sonnet').input, 11);
});

test('tokens land in the tier of message.model', async () => {
  const f = newTranscript('tiers');
  fs.appendFileSync(f,
    rec('f1', 'claude-fable-5-2', 1000, 100) + rec('o1', 'claude-opus-5-5', 2000, 200) +
    rec('s1', 'claude-sonnet-5-0', 3000, 300) + rec('h1', 'claude-haiku-5-5', 4000, 400));
  const u = await new UsageMeter(f).scan();
  for (const [tier, input, output, model] of [['fable', 1000, 100, 'claude-fable-5-2'], ['opus', 2000, 200, 'claude-opus-5-5'], ['sonnet', 3000, 300, 'claude-sonnet-5-0'], ['haiku', 4000, 400, 'claude-haiku-5-5']]) {
    const r = tierRow(u, tier);
    assert.ok(r, `${tier} present`);
    assert.equal(r.input, input, `${tier} input`);
    assert.equal(r.output, output, `${tier} output`);
    close(r.cost, price(model, r), `${tier} cost`);
  }
  assert.equal(u.total.input, 10000);
});

test('subagent transcripts are included and reported under usage.agents with their tier', async () => {
  const f = newTranscript('withsubs');
  const sub = path.join(dir, 'withsubs', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.appendFileSync(f, rec('main1', 'claude-fable-5-2', 500, 50));
  fs.writeFileSync(path.join(sub, 'agent-abc123.jsonl'), rec('sa1', 'claude-haiku-5-5', 700, 70));
  fs.writeFileSync(path.join(sub, 'agent-def456.jsonl'), rec('sb1', 'claude-opus-5-5', 900, 90));
  const u = await new UsageMeter(f).scan();
  assert.equal(u.agents.abc123?.tier, 'haiku');
  assert.equal(u.agents.def456?.tier, 'opus');
  assert.equal(u.total.input, 2100);
  assert.equal(tierRow(u, 'haiku').input, 700);
  assert.equal(tierRow(u, 'opus').input, 900);
});

test('soloCost equals all tokens priced at the main transcript\'s tier', async () => {
  const f = newTranscript('solo');
  const sub = path.join(dir, 'solo', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.appendFileSync(f, rec('m1', 'claude-fable-5-2', 1800, 420, 21000, 3000));
  fs.writeFileSync(path.join(sub, 'agent-x.jsonl'), rec('x1', 'claude-opus-5-5', 14000, 900, 8000, 100) + rec('x2', 'claude-haiku-5-5', 5000, 400));
  const u = await new UsageMeter(f).scan();
  const total = { input: 1800 + 14000 + 5000, output: 420 + 900 + 400, cacheRead: 21000 + 8000, cacheWrite: 3100 };
  assert.equal(u.mainTier, 'fable');
  close(u.soloCost, price('claude-fable-5-2', total), 'soloCost');
  close(u.total.cost, price('claude-fable-5-2', { input: 1800, output: 420, cacheRead: 21000, cacheWrite: 3000 }) + price('claude-opus-5-5', { input: 14000, output: 900, cacheRead: 8000, cacheWrite: 100 }) + price('claude-haiku-5-5', { input: 5000, output: 400, cacheRead: 0, cacheWrite: 0 }), 'total cost');
});

test('a transcript truncated and rewritten (scanned in between) is re-read without double counting', async () => {
  const f = newTranscript('trunc1');
  const m = new UsageMeter(f);
  fs.writeFileSync(f, rec('a', 'claude-opus-5-5', 100, 10) + rec('b', 'claude-opus-5-5', 200, 20));
  await m.scan();
  fs.writeFileSync(f, '');
  await m.scan();
  fs.writeFileSync(f, rec('c', 'claude-opus-5-5', 1000, 100) + rec('d', 'claude-opus-5-5', 2000, 200) + rec('e', 'claude-opus-5-5', 3000, 300));
  const u = await m.scan();
  assert.equal(tierRow(u, 'opus').input, 6000);
  assert.equal(tierRow(u, 'opus').output, 600);
});

test('a transcript truncated and rewritten shorter between scans is re-read without double counting', async () => {
  const f = newTranscript('trunc2');
  const m = new UsageMeter(f);
  fs.writeFileSync(f, rec('a', 'claude-opus-5-5', 100, 10) + rec('b', 'claude-opus-5-5', 200, 20) + rec('c', 'claude-opus-5-5', 300, 30));
  let u = await m.scan();
  assert.equal(tierRow(u, 'opus').input, 600);
  fs.writeFileSync(f, rec('z', 'claude-opus-5-5', 50, 5));
  u = await m.scan();
  assert.equal(tierRow(u, 'opus').input, 50);
  assert.equal(tierRow(u, 'opus').output, 5);
});

test('through the server: usage and per-agent tiers appear in /state after a Stop', async () => {
  const f = newTranscript('e2e');
  const sub = path.join(dir, 'e2e', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.appendFileSync(f, rec('m1', 'claude-fable-5-2', 1000, 100));
  fs.writeFileSync(path.join(sub, 'agent-cookA.jsonl'), rec('c1', 'claude-sonnet-5-0', 400, 40));
  const s = k.kitchenSession();
  const extra = { transcript_path: f };
  await s.send('UserPromptSubmit', { ...extra, prompt: 'x' });
  await s.send('SubagentStart', { ...extra, agent_id: 'cookA', agent_type: 'monkey-kitchen:line-cook' });
  await s.send('SubagentStop', { ...extra, agent_id: 'cookA', agent_type: 'monkey-kitchen:line-cook', last_assistant_message: 'r' });
  await s.send('Stop', extra);
  const st = await k.until(x => { const ss = x.sessions.find(y => y.id === s.id); return ss?.usage?.agents?.cookA && ss; }, 6000);
  assert.ok(st?.usage, 'usage reported');
  assert.equal(st.usage.mainTier, 'fable');
  assert.equal(st.usage.agents.cookA.tier, 'sonnet');
  assert.equal(st.usage.total.input, 1400);
  assert.equal(st.cooks.find(c => c.id === 'cookA').tier, 'sonnet');
});

// ---- Per-model rate cards (pricing.json `models`, then `tiers`) ----
const recU = (id, model, usage) => JSON.stringify({ type: 'assistant', uuid: 'u' + n++, message: { id, model, usage } }) + '\n';
const T = { input: 1000, output: 200, cacheRead: 5000, cacheWrite: 300 };
const usageOf = t => ({ input_tokens: t.input, output_tokens: t.output, cache_read_input_tokens: t.cacheRead, cache_creation_input_tokens: t.cacheWrite });

test('a claude-haiku-4-5-... message is priced at the claude-haiku-4-5 card, not the haiku tier', async () => {
  const card = PRICING.models['claude-haiku-4-5'], tier = PRICING.tiers.haiku;
  assert.ok(card && tier && card.input !== tier.input, 'precondition: the card differs from the tier');
  const f = newTranscript('haiku45');
  fs.appendFileSync(f, recU('h45', 'claude-haiku-4-5-20251001', usageOf(T)));
  const u = await new UsageMeter(f).scan();
  const r = tierRow(u, 'haiku');
  close(r.cost, cost(card, T), 'haiku-4-5 cost');
  assert.ok(Math.abs(r.cost - cost(tier, T)) > 1e-6, 'not the tier price');
});

test('an unknown model id such as claude-sonnet-9-1 is priced at the sonnet tier', async () => {
  const f = newTranscript('sonnet91');
  fs.appendFileSync(f, recU('s91', 'claude-sonnet-9-1', usageOf(T)));
  const u = await new UsageMeter(f).scan();
  const r = tierRow(u, 'sonnet');
  assert.ok(r, 'sonnet row');
  close(r.cost, cost(PRICING.tiers.sonnet, T), 'sonnet tier cost');
});

test('cache_creation.ephemeral_1h_input_tokens is priced at cacheWrite1h and ephemeral_5m at cacheWrite5m', async () => {
  const f = newTranscript('cache1h');
  const model = 'claude-opus-5-5', card = PRICING.models[model];
  assert.notEqual(card.cacheWrite5m, card.cacheWrite1h, 'precondition: rates differ');
  fs.appendFileSync(f, recU('c1', model, {
    input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 3000,
    cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 },
  }));
  const u = await new UsageMeter(f).scan();
  const r = tierRow(u, 'opus');
  assert.equal(r.cacheWrite5m, 1000);
  assert.equal(r.cacheWrite1h, 2000);
  assert.equal(r.cacheWrite, 3000);
  close(r.cost, (10 * card.input + 20 * card.output + 1000 * card.cacheWrite5m + 2000 * card.cacheWrite1h) / 1e6, '5m/1h cost');
});

test('usage.speed "fast" applies the card\'s fast multiplier (and none when the card has none)', async () => {
  const f = newTranscript('fast');
  const opus = PRICING.models['claude-opus-5-5'], sonnet = PRICING.models['claude-sonnet-5-5'];
  assert.ok(opus.fast > 1 && !sonnet.fast, 'precondition');
  fs.appendFileSync(f, recU('f1', 'claude-opus-5-5', { ...usageOf(T), speed: 'fast' }) + recU('f2', 'claude-sonnet-5-5', { ...usageOf(T), speed: 'fast' }));
  const u = await new UsageMeter(f).scan();
  close(tierRow(u, 'opus').cost, cost(opus, T) * opus.fast, 'opus fast cost');
  close(tierRow(u, 'sonnet').cost, cost(sonnet, T), 'sonnet fast cost (no multiplier)');
});

test('a malformed pricing.json does not stop the server from starting, and usage is still reported', async () => {
  const copy = tempDir('mk-pricing-');
  let kk;
  try {
    fs.mkdirSync(path.join(copy, 'server'));
    for (const f of fs.readdirSync(path.join(ROOT, 'server')).filter(n => n.endsWith('.mjs'))) fs.copyFileSync(path.join(ROOT, 'server', f), path.join(copy, 'server', f));
    fs.writeFileSync(path.join(copy, 'server', 'pricing.json'), '{ "models": { this is not json');
    kk = await startKitchen({}, { server: path.join(copy, 'server', 'server.mjs') });
    assert.equal(await kk.health(), 200, 'server up');
    const f = newTranscript('badpricing');
    fs.appendFileSync(f, rec('m1', 'claude-opus-5-5', 1000, 100));
    const s = kk.kitchenSession();
    await s.send('UserPromptSubmit', { transcript_path: f, prompt: 'x' });
    await s.send('Stop', { transcript_path: f });
    const st = await kk.until(x => x.sessions.find(y => y.id === s.id)?.usage, 5000);
    assert.ok(st, 'usage reported with built-in prices');
    assert.ok(st.total.cost > 0, 'priced');
  } finally {
    await kk?.stop();
    rmDir(copy);
  }
});
