// Reading a session back from its transcripts after a server restart (server/recover.mjs and its merge in server.mjs).
// Every transcript here is synthetic (test/helpers/transcripts.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { startKitchen, tempDir, rmDir, sleep } from './helpers/kitchen.mjs';
import { kitchenScene, writeJsonl, writeCook, userRec, assistantRecs, toolUse, text, age, subDir } from './helpers/transcripts.mjs';
import { readBack } from '../server/recover.mjs';

let k, kd, dir;
// kd waits 500 ms before each read-back, so a test can land live events before it.
before(async () => { k = await startKitchen(); kd = await startKitchen({ MONKEY_KITCHEN_RECOVER_DELAY_MS: '500' }); dir = tempDir('mk-recover-'); });
after(async () => { await k?.stop(); await kd?.stop(); rmDir(dir); });

const LINE = 'monkey-kitchen:line-cook', TASTER = 'monkey-kitchen:taster';
const recovered = (s, ms = 5000, kk = k) => kk.until(st => { const x = st.sessions.find(y => y.id === s.id); return x?.recovered && x; }, ms);
const scene = (opts) => kitchenScene(dir, 'main-' + crypto.randomUUID(), opts);

test('one event from a session the server does not know rebuilds the order and its cooks from the transcripts', async () => {
  const { main, T } = scene();
  const s = k.kitchenSession();
  await s.send('PreToolUse', { tool_name: 'Read', tool_input: { file_path: 'x.js' }, transcript_path: main });
  const st = await recovered(s);
  assert.ok(st, 'session marked recovered');
  assert.equal(st.order.text, 'Make the soup hotter', 'latest real prompt, reminder stripped, meta and notices skipped');
  assert.equal(st.order.startedAt, T);
  assert.equal(st.order.status, 'cooking');
  assert.deepEqual(st.cooks.map(c => c.id).sort(), ['c1', 'c2'], 'the cook that started before the order is left out');
  const c1 = st.cooks.find(c => c.id === 'c1');
  assert.equal(c1.status, 'done');
  assert.equal(c1.agentType, LINE);
  assert.equal(c1.role, 'line-cook');
  assert.equal(c1.ticket, 'Heat the soup');
  assert.equal(c1.prompt, 'Full prompt for the line cook.', 'prompt from the Agent call matched by toolUseId');
  assert.equal(c1.report, 'The soup is\nnow hot.');
  assert.equal(c1.tools, 2);
  assert.deepEqual(c1.log.map(e => e.text), ['Reading soup.js', 'Writing stove.js']);
  assert.equal(c1.model, 'claude-opus-5-5');
  assert.equal(c1.tier, 'opus');
  assert.ok(c1.endedAt > 0);
  const c2 = st.cooks.find(c => c.id === 'c2');
  assert.equal(c2.status, 'working', 'a cook whose last word was a tool call is still working');
  assert.equal(c2.ticket, 'Taste the soup');
  assert.equal(c2.prompt, 'Full prompt for the taster.');
  assert.equal(c2.report, '');
  assert.equal(c2.activity, 'Running: Run the tests');
  assert.equal(c2.tier, 'sonnet');
  assert.equal(st.feed.filter(e => e.text === 'picked up where the kitchen left off').length, 1, 'one feed line');
  assert.equal(st.chef.status, 'working');
});

test('a cook transcript without a matching Agent call or meta file takes its prompt from its own first record', async () => {
  const { main, T } = scene();
  const f = writeCook(main, 'c3', [userRec('Prompt only the cook file has', T + 7000, { isSidechain: true }), ...assistantRecs([text('Finished.')], T + 8000, { model: 'claude-opus-5-5', sidechain: true })]);
  age(f, 60 * 1000);
  const s = k.kitchenSession();
  await s.send('Notification', { notification_type: 'idle_prompt', message: 'x', transcript_path: main });
  const st = await recovered(s);
  const c3 = st.cooks.find(c => c.id === 'c3');
  assert.ok(c3);
  assert.equal(c3.prompt, 'Prompt only the cook file has');
  assert.equal(c3.ticket, 'Prompt only the cook file has');
  assert.equal(c3.role, 'stagiaire');
  assert.equal(c3.status, 'done');
  assert.equal(c3.report, 'Finished.');
});

test('a main thread whose last word was the assistant\'s, settled for 30 s, is read back as served', async () => {
  const { main } = scene({ mainSettled: true });
  const s = k.kitchenSession();
  await s.send('SessionStart', { source: 'resume', transcript_path: main });
  const st = await recovered(s);
  assert.equal(st.order.status, 'served');
  assert.equal(st.chef.status, 'idle');
});

test('a live UserPromptSubmit wins over the read-back order; finished old cooks stay off the rail, working ones join', async () => {
  const { main } = scene();
  const s = k.kitchenSession();
  await s.send('UserPromptSubmit', { prompt: 'A brand new order', transcript_path: main });
  const st = await recovered(s);
  assert.equal(st.order.text, 'A brand new order');
  assert.equal(st.order.status, 'cooking');
  assert.deepEqual(st.cooks.map(c => c.id), ['c2']);
});

test('live events for a cook are not overwritten by the read-back; the gaps are filled', async () => {
  const { main } = scene();
  const s = k.kitchenSession();
  // The triggering event itself finishes c1 live, before the read-back can complete.
  await s.send('SubagentStop', { agent_id: 'c1', agent_type: LINE, last_assistant_message: 'Live report', transcript_path: main });
  await s.send('PreToolUse', { agent_id: 'c2', agent_type: TASTER, tool_name: 'Grep', tool_input: { pattern: 'salt' }, transcript_path: main });
  const st = await recovered(s);
  const c1 = st.cooks.find(c => c.id === 'c1');
  assert.equal(c1.status, 'done');
  assert.equal(c1.report, 'Live report', 'the live report stays');
  assert.equal(c1.ticket, 'Heat the soup', 'the missing ticket is filled in');
  assert.equal(c1.prompt, 'Full prompt for the line cook.');
  const c2 = st.cooks.find(c => c.id === 'c2');
  assert.equal(c2.status, 'working');
  assert.equal(c2.activity, 'Searching for "salt"', 'the live activity stays');
  assert.equal(c2.log[c2.log.length - 1].text, 'Searching for "salt"', 'live steps stay last');
  assert.ok(c2.log.some(e => e.text === 'Running: Run the tests'), 'earlier steps from the transcript go before them');
  assert.equal(c2.ticket, 'Taste the soup');
  // A recovered cook then behaves like any other.
  await s.tool('c2', TASTER, 'Read', { file_path: 'pot.txt' });
  await s.finish('c2', TASTER, 'Salty enough.');
  const after = await s.cook('c2');
  assert.equal(after.status, 'done');
  assert.equal(after.report, 'Salty enough.');
  assert.equal(after.log[after.log.length - 1].text, 'Reading pot.txt');
});

test('a SessionStart with source startup does not read anything back, nor does a later event', async () => {
  const { main } = scene();
  const s = k.kitchenSession();
  await s.send('SessionStart', { source: 'startup', transcript_path: main });
  await s.send('PreToolUse', { tool_name: 'Read', tool_input: { file_path: 'y' }, transcript_path: main });
  await sleep(800);
  const st = await s.get();
  assert.equal(st.recovered, false);
  assert.equal(st.cooks.length, 0);
  assert.notEqual(st.order?.text, 'Make the soup hotter');
  assert.ok(!st.feed.some(e => e.text === 'picked up where the kitchen left off'));
});

test('malformed transcript files are tolerated: what is readable is recovered, the rest skipped', async () => {
  const main = path.join(dir, 'bad-' + crypto.randomUUID() + '.jsonl');
  const T = Date.now() - 5 * 60 * 1000;
  writeJsonl(main, [
    '{"type":"user","timestamp":', 'not json at all', '\u0000\u0001\u0002', '[1,2,3]', '{"type":"user"}',
    userRec('The readable order', T),
    { type: 'user', timestamp: 'yesterday-ish', message: { content: 'an order with a bad timestamp' } },
    '{"type":"assistant","message":{"content":"not an array"}}',
    { type: 'assistant', timestamp: new Date(T + 10).toISOString(), message: { content: [null, 5, { type: 'tool_use' }, { type: 'tool_use', id: 7, name: 'Agent', input: 'x' }] } },
  ]);
  writeCook(main, 'm1', ['garbage first line', userRec('p', T + 100)], '{ not json');
  writeCook(main, 'm2', [userRec('Second cook prompt', T + 200, { isSidechain: true }), '{"type":"assistant","timestamp":"x","message":{"content":[{"type":"tool_use","name":null,"input":null}]}}'], '[]');
  fs.writeFileSync(path.join(subDir(main), 'agent-empty.jsonl'), '');
  fs.writeFileSync(path.join(subDir(main), 'agent-.jsonl'), 'x');
  fs.mkdirSync(path.join(subDir(main), 'agent-dir.jsonl'));
  const s = k.kitchenSession();
  await s.send('PreToolUse', { tool_name: 'Read', tool_input: {}, transcript_path: main });
  const st = await recovered(s);
  assert.ok(st, 'still recovered');
  assert.equal(st.order.text, 'The readable order');
  assert.deepEqual(st.cooks.map(c => c.id), ['m2'], 'only the cook with a readable first record');
  assert.equal(st.cooks[0].prompt, 'Second cook prompt');
  assert.equal(st.cooks[0].tools, 1);
  assert.equal(await k.health(), 200);

  // Nothing usable at all, or no file: no read-back, no harm.
  const junk = path.join(dir, 'junk-' + crypto.randomUUID() + '.jsonl');
  fs.writeFileSync(junk, 'x\n{\n');
  const s2 = k.kitchenSession(), s3 = k.kitchenSession();
  await s2.send('PreToolUse', { tool_name: 'Read', tool_input: {}, transcript_path: junk });
  await s3.send('PreToolUse', { tool_name: 'Read', tool_input: {}, transcript_path: path.join(dir, 'missing.jsonl') });
  await sleep(600);
  assert.equal((await s2.get()).recovered, false);
  assert.equal((await s3.get()).recovered, false);
  assert.equal(await k.health(), 200);
  assert.equal(k.child.exitCode, null);
  assert.doesNotMatch(k.stderr(), /uncaught|unhandled/i);
});

test('readBack reads the main transcript from its end across chunks, skipping a record too long to buffer', { timeout: 20000 }, async () => {
  const main = path.join(dir, 'long-' + crypto.randomUUID() + '.jsonl');
  const T = Date.now() - 5 * 60 * 1000;
  const recs = [
    ...Array.from({ length: 3000 }, (_, i) => userRec('older order ' + i + ' ' + 'y'.repeat(500), T - 100000 + i)),
    userRec('The order to find', T),
    // 2.5 MB: spans several 1 MB chunks, and holds an Agent call.
    { type: 'assistant', timestamp: new Date(T + 1).toISOString(), message: { id: 'big', content: [{ type: 'text', text: 'z'.repeat(2.5 * 1024 * 1024) }, toolUse('toolu_big', 'Agent', { description: 'Big call', prompt: 'Prompt of the big call', subagent_type: 'monkey-kitchen:runner' })] } },
    // 9 MB: longer than a record may be; skipped whole.
    { type: 'user', timestamp: new Date(T + 2).toISOString(), message: { content: 'skipped ' + 'q'.repeat(9 * 1024 * 1024) } },
    ...assistantRecs([toolUse('toolu_x', 'Read', { file_path: 'a' })], T + 3),
  ];
  writeJsonl(main, recs);
  writeCook(main, 'r1', [userRec('cook first', T + 5, { isSidechain: true })], { agentType: 'monkey-kitchen:runner', toolUseId: 'toolu_big' });
  const r = await readBack(main, { promptOf: rec => (typeof rec.message?.content === 'string' && !rec.isMeta ? rec.message.content : null), describe: (t) => ['tool', t] });
  assert.equal(r.order.text, 'The order to find');
  assert.equal(r.cooks.length, 1);
  assert.equal(r.cooks[0].prompt, 'Prompt of the big call');
  assert.equal(r.cooks[0].description, 'Big call', 'meta without a description: the matched Agent call supplies it');
});

// ---------- rebuilt cooks are guesses until their first live event ----------

test('a rebuilt cook guessed done that sends a live event is working again; its SubagentStop brings the real report', async () => {
  const { main } = scene();
  const s = k.kitchenSession();
  await s.send('PreToolUse', { tool_name: 'Read', tool_input: { file_path: 'x.js' }, transcript_path: main });
  const st = await recovered(s);
  let c1 = st.cooks.find(c => c.id === 'c1');
  assert.equal(c1.status, 'done');
  assert.equal(c1.rebuilt, true);
  assert.equal(st.cooks.find(c => c.id === 'c2').rebuilt, true);
  await s.tool('c1', LINE, 'Bash', { command: 'make', description: 'One more build' });
  c1 = await s.cook('c1');
  assert.equal(c1.status, 'working', 'the live event wins over the guess');
  assert.equal(c1.rebuilt, false);
  assert.equal(c1.tools, 3, 'and is counted');
  assert.equal(c1.activity, 'Running: One more build');
  await s.finish('c1', LINE, 'The real report.');
  c1 = await s.cook('c1');
  assert.equal(c1.status, 'done');
  assert.equal(c1.report, 'The real report.', 'the live SubagentStop replaces the guessed report');
});

test('proof of completion wins over the quiet-file guess: a returned Agent call or a hand-back means done; a background launch does not', async () => {
  const main = path.join(dir, 'proof-' + crypto.randomUUID() + '.jsonl');
  const T = Date.now() - 5 * 60 * 1000;
  const result = (id, at, res) => ({ type: 'user', timestamp: new Date(at).toISOString(), toolUseResult: res, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'x' }] } });
  writeJsonl(main, [
    userRec('Cook three things', T),
    ...assistantRecs([toolUse('toolu_e1', 'Agent', { subagent_type: LINE, description: 'Returned', prompt: 'p1' })], T + 10),
    ...assistantRecs([toolUse('toolu_e2', 'Agent', { subagent_type: LINE, description: 'Launched', prompt: 'p2', run_in_background: true })], T + 20),
    ...assistantRecs([toolUse('toolu_e3', 'Agent', { subagent_type: LINE, description: 'Handed back', prompt: 'p3', run_in_background: true })], T + 30),
    result('toolu_e2', T + 40, { isAsync: true, status: 'async_launched', agentId: 'e2' }),
    result('toolu_e3', T + 41, { isAsync: true, status: 'async_launched', agentId: 'e3' }),
    result('toolu_e1', T + 50, { status: 'completed', agentId: 'e1' }),
    userRec('[Subagent hand-back] e3 is done', T + 60, { isMeta: true, origin: { kind: 'peer', from: 'e3', handback: true } }),
  ]);
  // All three files were just written (not settled), and each one's last word is plain text.
  for (const [id, tu] of [['e1', 'toolu_e1'], ['e2', 'toolu_e2'], ['e3', 'toolu_e3']]) {
    writeCook(main, id, [userRec('prompt ' + id, T + 15, { isSidechain: true }), ...assistantRecs([text('Report of ' + id)], T + 45, { model: 'claude-opus-5-5', sidechain: true })], { agentType: LINE, description: id, toolUseId: tu });
  }
  const s = k.kitchenSession();
  await s.send('PreToolUse', { tool_name: 'Read', tool_input: {}, transcript_path: main });
  const st = await recovered(s);
  const by = id => st.cooks.find(c => c.id === id);
  assert.equal(by('e1').status, 'done', 'its Agent call returned');
  assert.equal(by('e1').report, 'Report of e1');
  assert.equal(by('e2').status, 'working', 'launched in the background is not done, and its file has not settled');
  assert.equal(by('e2').report, '');
  assert.equal(by('e3').status, 'done', 'it handed back');
});

// ---------- when not to read back ----------

test('no read-back when the first event is a SessionEnd or a SessionStart from /clear', async () => {
  for (const [ev, extra] of [['SessionEnd', { reason: 'exit' }], ['SessionStart', { source: 'clear' }]]) {
    const { main } = scene();
    const s = k.kitchenSession();
    await s.send(ev, { ...extra, transcript_path: main });
    await s.send('PreToolUse', { tool_name: 'Read', tool_input: {}, transcript_path: main });
    await sleep(600);
    const st = await s.get();
    assert.equal(st.recovered, false, ev);
    assert.equal(st.cooks.length, 0, ev);
  }
});

test('a session that ended before its read-back landed gets its cooks finished and its order served', { timeout: 15000 }, async () => {
  const { main } = scene();
  const s = kd.kitchenSession();
  await s.send('PreToolUse', { tool_name: 'Read', tool_input: {}, transcript_path: main });
  await s.send('SessionEnd', { reason: 'exit', transcript_path: main });
  assert.equal((await s.get()).recovered, false, 'the read-back is still waiting');
  const st = await recovered(s, 5000, kd);
  assert.ok(st);
  assert.ok(st.cooks.length >= 2);
  for (const c of st.cooks) assert.equal(c.status, 'done', `${c.id} is not left working in an ended session`);
  assert.equal(st.order.status, 'served');
});

// ---------- rebuilt values follow the live limits ----------

test('rebuilt agent types and models are clipped to 200 characters, as live ones are', async () => {
  const main = path.join(dir, 'clip-' + crypto.randomUUID() + '.jsonl');
  const T = Date.now() - 5 * 60 * 1000;
  writeJsonl(main, [userRec('Long names', T)]);
  writeCook(main, 'long1', [userRec('p', T + 10, { isSidechain: true }), ...assistantRecs([toolUse('t', 'Read', { file_path: 'a' })], T + 20, { model: 'claude-opus-' + 'm'.repeat(500), sidechain: true })],
    { agentType: 'monkey-kitchen:' + 't'.repeat(500), description: 'd'.repeat(500) });
  const s = k.kitchenSession();
  await s.send('PreToolUse', { tool_name: 'Read', tool_input: {}, transcript_path: main });
  const st = await recovered(s);
  const c = st.cooks.find(x => x.id === 'long1');
  assert.ok(c.agentType.length <= 200, `agentType ${c.agentType.length}`);
  assert.ok(c.model.length <= 200, `model ${c.model.length}`);
  assert.ok(c.ticket.length <= 200, `ticket ${c.ticket.length}`);
  assert.equal(c.tier, 'opus');
});

// ---------- step counts when live events came first ----------

test('steps both live events and the transcript saw are counted once, even past the 20-step log', { timeout: 15000 }, async () => {
  const main = path.join(dir, 'steps-' + crypto.randomUUID() + '.jsonl');
  const T = Date.now() - 60 * 1000;
  writeJsonl(main, [userRec('Read many files', T)]);
  const recs = [userRec('read them', T + 10, { isSidechain: true }), ...assistantRecs([toolUse('b0', 'Bash', { command: 'ls', description: 'List' })], T + 100, { model: 'claude-opus-5-5', sidechain: true })];
  const times = Array.from({ length: 22 }, (_, i) => T + 1000 + i * 1000);
  times.forEach((t, i) => recs.push(...assistantRecs([toolUse('r' + i, 'Read', { file_path: `f${i}.js` })], t, { model: 'claude-opus-5-5', sidechain: true })));
  writeCook(main, 'many', recs, { agentType: LINE, description: 'Many reads' });
  const s = kd.kitchenSession();
  await s.send('PreToolUse', { tool_name: 'Read', tool_input: {}, transcript_path: main });
  // The 22 reads also arrive live (each stamped just after its transcript record) before the read-back lands.
  await Promise.all(times.map((t, i) => s.send('PreToolUse', { agent_id: 'many', agent_type: LINE, tool_name: 'Read', tool_input: { file_path: `f${i}.js` } }, { ts: t + 50 })));
  assert.equal((await s.get()).recovered, false, 'the live events came first');
  const st = await recovered(s, 5000, kd);
  const c = st.cooks.find(x => x.id === 'many');
  assert.equal(c.tools, 23, 'one Bash and 22 reads');
  assert.equal(c.log.length, 20);
  assert.equal(c.log[c.log.length - 1].text, 'Reading f21.js');
  assert.equal(new Set(c.log.map(e => e.text)).size, 20, 'no step twice');
});

test('two identical steps in the transcript stay two when one of them also arrived live', { timeout: 15000 }, async () => {
  const main = path.join(dir, 'twins-' + crypto.randomUUID() + '.jsonl');
  const T = Date.now() - 60 * 1000;
  writeJsonl(main, [userRec('Read it twice', T)]);
  writeCook(main, 'twice', [
    userRec('read', T + 10, { isSidechain: true }),
    ...assistantRecs([toolUse('a', 'Read', { file_path: 'a.js' })], T + 1000, { model: 'claude-opus-5-5', sidechain: true }),
    ...assistantRecs([toolUse('b', 'Read', { file_path: 'a.js' })], T + 2000, { model: 'claude-opus-5-5', sidechain: true }),
  ], { agentType: LINE, description: 'Twice' });
  const s = kd.kitchenSession();
  await s.send('PreToolUse', { tool_name: 'Read', tool_input: {}, transcript_path: main });
  await s.send('PreToolUse', { agent_id: 'twice', agent_type: LINE, tool_name: 'Read', tool_input: { file_path: 'a.js' } }, { ts: T + 2050 });
  const st = await recovered(s, 5000, kd);
  const c = st.cooks.find(x => x.id === 'twice');
  assert.equal(c.log.filter(e => e.text === 'Reading a.js').length, 2);
  assert.equal(c.tools, 2);
});

// ---------- background cooks end with a SubagentHandback call ----------

const handback = (id, message) => toolUse(id, 'SubagentHandback', { message });
const reply = (id, at) => ({ type: 'user', isSidechain: true, timestamp: new Date(at).toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'delivered' }] } });

test('a SubagentHandback call means done, its message is the report (clipped like a live one), and it counts as a step', async () => {
  const main = path.join(dir, 'hb-' + crypto.randomUUID() + '.jsonl');
  const T = Date.now() - 5 * 60 * 1000;
  writeJsonl(main, [userRec('Hand it back', T)]);
  const medium = 'Medium report. ' + 'm'.repeat(2500), long = 'Long report. ' + 'l'.repeat(9000);
  // Both files were just written (not settled) and end with the call's result: only the call says they are done.
  writeCook(main, 'hb1', [
    userRec('p', T + 10, { isSidechain: true }),
    ...assistantRecs([toolUse('r1', 'Read', { file_path: 'a.js' })], T + 20, { model: 'claude-opus-5-5', sidechain: true }), reply('r1', T + 21),
    ...assistantRecs([text('Short remark before handing back.')], T + 25, { model: 'claude-opus-5-5', sidechain: true }),
    ...assistantRecs([handback('h1', medium)], T + 30, { model: 'claude-opus-5-5', sidechain: true }), reply('h1', T + 31),
  ], { agentType: 'monkey-kitchen:scribe', description: 'Write it up' });
  writeCook(main, 'hb2', [
    userRec('p', T + 10, { isSidechain: true }),
    ...assistantRecs([handback('h2', long)], T + 30, { model: 'claude-opus-5-5', sidechain: true }), reply('h2', T + 31),
  ], { agentType: 'monkey-kitchen:inspector', description: 'Inspect' });
  const s = k.kitchenSession();
  await s.send('PreToolUse', { tool_name: 'Read', tool_input: {}, transcript_path: main });
  const st = await recovered(s);
  const hb1 = st.cooks.find(c => c.id === 'hb1'), hb2 = st.cooks.find(c => c.id === 'hb2');
  assert.equal(hb1.status, 'done');
  assert.equal(hb1.report, medium, 'the whole hand-back message, not the last assistant text');
  assert.equal(hb1.tools, 2, 'Read and SubagentHandback, as live PreToolUse events would count them');
  assert.equal(hb1.log[hb1.log.length - 1].text, 'Using SubagentHandback');
  assert.equal(hb2.status, 'done');
  assert.equal(hb2.report.length, 4000, 'clipped to 4000 like a live report');
  assert.ok(hb2.report.startsWith('Long report. '));
});

test('records after the hand-back (its result, a closing remark, thinking) leave the cook done with the hand-back as report', async () => {
  const main = path.join(dir, 'hbtail-' + crypto.randomUUID() + '.jsonl');
  const T = Date.now() - 5 * 60 * 1000;
  writeJsonl(main, [userRec('Hand it back, then chat', T)]);
  writeCook(main, 'tail', [
    userRec('p', T + 10, { isSidechain: true }),
    ...assistantRecs([handback('h', 'The real report.')], T + 30, { model: 'claude-opus-5-5', sidechain: true }), reply('h', T + 31),
    ...assistantRecs([{ type: 'thinking', thinking: 'x' }, text('Handed back; stopping here.')], T + 40, { model: 'claude-opus-5-5', sidechain: true }),
  ], { agentType: 'monkey-kitchen:runner', description: 'Run' });
  const s = k.kitchenSession();
  await s.send('PreToolUse', { tool_name: 'Read', tool_input: {}, transcript_path: main });
  const c = (await recovered(s)).cooks.find(x => x.id === 'tail');
  assert.equal(c.status, 'done');
  assert.equal(c.report, 'The real report.');
});

test('a cook resumed after its hand-back (a new message, then more tools) is working, whatever the main thread recorded', async () => {
  const main = path.join(dir, 'hbresume-' + crypto.randomUUID() + '.jsonl');
  const T = Date.now() - 5 * 60 * 1000;
  writeJsonl(main, [
    userRec('Hand back, then keep going', T),
    userRec('[Subagent hand-back] first report', T + 35, { isMeta: true, origin: { kind: 'peer', from: 'again', handback: true } }),
  ]);
  // Not settled, so the quiet-file guess does not apply either.
  writeCook(main, 'again', [
    userRec('p', T + 10, { isSidechain: true }),
    ...assistantRecs([handback('h', 'First report.')], T + 30, { model: 'claude-opus-5-5', sidechain: true }), reply('h', T + 31),
    userRec('Please also check the tests.', T + 50, { isSidechain: true }),
    ...assistantRecs([toolUse('g', 'Grep', { pattern: 'test' })], T + 60, { model: 'claude-opus-5-5', sidechain: true }), reply('g', T + 61),
    ...assistantRecs([text('Still looking.')], T + 70, { model: 'claude-opus-5-5', sidechain: true }),
  ], { agentType: LINE, description: 'Again' });
  const s = k.kitchenSession();
  await s.send('PreToolUse', { tool_name: 'Read', tool_input: {}, transcript_path: main });
  const c = (await recovered(s)).cooks.find(x => x.id === 'again');
  assert.equal(c.status, 'working');
  assert.equal(c.report, '');
});

test('without a hand-back call a text-only ending is still judged by the quiet-file rule', async () => {
  const main = path.join(dir, 'nohb-' + crypto.randomUUID() + '.jsonl');
  const T = Date.now() - 5 * 60 * 1000;
  writeJsonl(main, [userRec('Plain endings', T)]);
  const ending = id => [userRec('p', T + 10, { isSidechain: true }), ...assistantRecs([text('Plain report of ' + id)], T + 20, { model: 'claude-opus-5-5', sidechain: true })];
  age(writeCook(main, 'settled', ending('settled'), { agentType: LINE, description: 'Settled' }), 60 * 1000);
  writeCook(main, 'fresh', ending('fresh'), { agentType: LINE, description: 'Fresh' });
  const s = k.kitchenSession();
  await s.send('PreToolUse', { tool_name: 'Read', tool_input: {}, transcript_path: main });
  const st = await recovered(s);
  const settled = st.cooks.find(c => c.id === 'settled'), fresh = st.cooks.find(c => c.id === 'fresh');
  assert.equal(settled.status, 'done');
  assert.equal(settled.report, 'Plain report of settled');
  assert.equal(fresh.status, 'working', 'not settled yet');
  assert.equal(fresh.report, '');
});

test('records that are shell-mode input or output, memory input or local command output are not orders', async () => {
  const main = path.join(dir, 'notorders-' + crypto.randomUUID() + '.jsonl');
  const T = Date.now() - 5 * 60 * 1000;
  writeJsonl(main, [
    userRec('The real order', T),
    userRec('<bash-input>ls</bash-input>', T + 10),
    userRec('<bash-stdout>a b</bash-stdout><bash-stderr></bash-stderr>', T + 20),
    userRec('<bash-stderr>oops</bash-stderr>', T + 25),
    userRec('<user-memory-input>remember this</user-memory-input>', T + 30),
    userRec('<local-command-stdout>cost: 0</local-command-stdout>', T + 40),
  ]);
  const s = k.kitchenSession();
  await s.send('PreToolUse', { tool_name: 'Read', tool_input: {}, transcript_path: main });
  const st = await recovered(s);
  assert.equal(st.order.text, 'The real order');
});
