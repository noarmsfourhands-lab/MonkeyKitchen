// The v2 feed: GET /events frames, GET /cook, GET /chef, and GET /state in full; effort levels.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startKitchen, watch, sleep, tempDir, rmDir } from './helpers/kitchen.mjs';

let k, dir;
const watchers = [];
before(async () => { k = await startKitchen(); dir = tempDir('mk-feed-'); });
after(async () => { for (const w of watchers) w.close(); await k?.stop(); rmDir(dir); });

const LINE = 'monkey-kitchen:line-cook';
const open = p => { const w = watch(k.port, p); watchers.push(w); return w; };
const SUMMARY_KEYS = ['chefStatus', 'id', 'lastEventAt', 'orderStatus', 'project', 'working'];

test('GET /events?session=<id> sends v2 frames: {v: 2, now, sessions: [summaries], session: the requested one}', async () => {
  const A = k.kitchenSession(), B = k.kitchenSession();
  await A.prompt('order for A');
  await sleep(5);
  await B.prompt('order for B'); // B is now the most recent; A is asked for explicitly
  const w = open(`/events?session=${encodeURIComponent(A.id)}`);
  const f = await w.next();
  assert.ok(f, 'a frame arrived');
  assert.match(w.headers['content-type'], /text\/event-stream/);
  assert.equal(f.v, 2);
  assert.equal(typeof f.now, 'number');
  assert.ok(Array.isArray(f.sessions));
  for (const x of f.sessions) assert.deepEqual(Object.keys(x).sort(), SUMMARY_KEYS, 'summary has exactly the listed fields');
  const sa = f.sessions.find(x => x.id === A.id);
  assert.ok(sa, 'A listed');
  assert.equal(sa.chefStatus, 'working');
  assert.equal(sa.orderStatus, 'cooking');
  assert.equal(sa.working, 0);
  assert.equal(typeof sa.lastEventAt, 'number');
  assert.ok(f.sessions.find(x => x.id === B.id), 'B listed');
  assert.equal(f.session.id, A.id, 'session is the requested one, not the most recent');
  assert.equal(f.session.order.text, 'order for A');
});

test('a client with no session parameter follows the most recently active session', async () => {
  const A = k.kitchenSession(), B = k.kitchenSession();
  await A.prompt('follow A');
  const w = open('/events');
  assert.ok(await w.next(f => f.session?.id === A.id), 'follows A first');
  await sleep(5);
  await B.prompt('follow B');
  assert.ok(await w.next(f => f.session?.id === B.id), 'switches to B when B is most recent');
  const from = w.frames.length;
  await sleep(5);
  await A.tool(null, null, 'Read', { file_path: 'a.txt' });
  const f = await w.next(fr => fr.session?.id === A.id, 3000, from);
  assert.ok(f, 'back to A after A is active again');
  assert.equal(f.session.order.text, 'follow A');
});

test('two clients watching different sessions each receive only their own session object', async () => {
  const A = k.kitchenSession(), B = k.kitchenSession();
  await A.prompt('only A here');
  await B.prompt('only B here');
  const wa = open(`/events?session=${encodeURIComponent(A.id)}`), wb = open(`/events?session=${encodeURIComponent(B.id)}`);
  await wa.next(); await wb.next();
  for (let i = 0; i < 3; i++) {
    await A.tool(null, null, 'Read', { file_path: `a${i}.txt` });
    await B.tool(null, null, 'Read', { file_path: `b${i}.txt` });
    await sleep(200);
  }
  await B.start('b-cook', LINE);
  await wb.next(f => f.session?.cooks?.some(c => c.id === 'b-cook'));
  await sleep(300);
  assert.ok(wa.frames.length > 1 && wb.frames.length > 1, 'both received updates');
  for (const f of wa.frames) { assert.equal(f.session.id, A.id); assert.ok(!JSON.stringify(f.session).includes('only B here')); }
  for (const f of wb.frames) { assert.equal(f.session.id, B.id); assert.ok(!JSON.stringify(f.session).includes('only A here')); }
  assert.ok(!wa.frames.some(f => f.session.cooks.some(c => c.id === 'b-cook')), "A's client never sees B's cook");
});

test('in a frame, cooks have promptLen/reportLen, a log of at most 8, an effort string, and no prompt, report or guessCall', async () => {
  const s = k.kitchenSession();
  await s.prompt('frame cooks');
  const longPrompt = 'P'.repeat(1500), longReport = 'R'.repeat(2500);
  // No PostToolUse: the cook gets its ticket by guesswork, which sets guessCall inside the server.
  await s.call('tu1', LINE, 'Guessed ticket', longPrompt);
  await s.start('c1', LINE);
  for (let i = 0; i < 12; i++) await s.tool('c1', LINE, 'Read', { file_path: `f${i}.txt` });
  await s.send('PreToolUse', { agent_id: 'c1', agent_type: LINE, tool_name: 'Read', tool_input: { file_path: 'last.txt' }, effort: { level: 'high' } });
  const w = open(`/events?session=${encodeURIComponent(s.id)}`);
  let f = await w.next(fr => fr.session?.cooks?.length);
  let c = f.session.cooks.find(x => x.id === 'c1');
  assert.equal(c.ticket, 'Guessed ticket', 'precondition: guessed');
  for (const key of ['prompt', 'report', 'guessCall']) assert.ok(!(key in c), `no ${key} in a frame cook`);
  assert.equal(c.promptLen, longPrompt.length);
  assert.equal(c.reportLen, 0);
  assert.ok(c.log.length <= 8, `log has ${c.log.length}`);
  assert.equal(c.log.length, 8);
  assert.match(c.log[7].text, /last\.txt/, 'newest entries kept');
  assert.equal(typeof c.effort, 'string');
  assert.equal(c.effort, 'high');
  await s.finish('c1', LINE, longReport);
  f = await w.next(fr => fr.session?.cooks?.find(x => x.id === 'c1')?.status === 'done');
  c = f.session.cooks.find(x => x.id === 'c1');
  assert.equal(c.reportLen, longReport.length);
  assert.ok(!('report' in c));
});

test('no frame is sent when nothing changed (a later rescan of an unchanged transcript sends nothing)', { timeout: 15000 }, async () => {
  const s = k.kitchenSession();
  const f = path.join(dir, 'quiet.jsonl');
  fs.writeFileSync(f, JSON.stringify({ type: 'assistant', uuid: 'q1', message: { id: 'q1', model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 1 } } }) + '\n');
  await s.send('UserPromptSubmit', { transcript_path: f, prompt: 'x' });
  const w = open(`/events?session=${encodeURIComponent(s.id)}`);
  await w.next();
  // Nothing happens: no frame.
  let n = w.frames.length;
  await sleep(1200);
  assert.equal(w.frames.length, n, 'no frame with no events');
  // A Stop schedules a scan at ~300 ms (usage appears: a frame) and another at ~2.5 s that finds nothing new.
  await s.send('Stop', { transcript_path: f });
  assert.ok(await w.next(fr => fr.session?.usage, 3000), 'frame with usage');
  await sleep(300);
  n = w.frames.length;
  await sleep(3000);
  assert.equal(w.frames.length, n, 'the late rescan with unchanged usage sends no frame');
  // Control: a real change still sends a frame.
  await s.tool(null, null, 'Read', { file_path: 'x' });
  assert.ok(await w.next(() => true, 2000, n), 'a change sends a frame');
});

test('GET /cook returns full prompt, report and up to 20 log entries; unknown session or cook is 404; GET /chef returns {log}', async () => {
  const s = k.kitchenSession();
  await s.prompt('cook detail');
  const prompt = 'Do the thing. '.repeat(200).trim(), report = 'Line of report.\n'.repeat(150).trim();
  await s.call('tu1', LINE, 'Detail ticket', prompt);
  await s.start('d1', LINE);
  await s.ret('tu1', { agentId: 'd1' });
  for (let i = 0; i < 25; i++) await s.tool('d1', LINE, 'Read', { file_path: `f${i}.txt` });
  await s.finish('d1', LINE, report);
  await s.tool(null, null, 'Grep', { pattern: 'needle' });
  const q = `session=${encodeURIComponent(s.id)}`;
  const r = await k.request({ path: `/cook?${q}&id=d1` });
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.deepEqual(Object.keys(body).sort(), ['id', 'log', 'prompt', 'report']);
  assert.equal(body.id, 'd1');
  assert.equal(body.prompt, prompt);
  assert.equal(body.report, report);
  assert.equal(body.log.length, 20);
  assert.match(body.log[19].text, /f24\.txt/);
  assert.equal((await k.request({ path: `/cook?${q}&id=nope` })).status, 404, 'unknown cook');
  assert.equal((await k.request({ path: `/cook?session=nope&id=d1` })).status, 404, 'unknown session');
  const chef = await k.request({ path: `/chef?${q}` });
  assert.equal(chef.status, 200);
  const cb = JSON.parse(chef.body);
  assert.deepEqual(Object.keys(cb), ['log']);
  assert.ok(cb.log.some(e => /needle/.test(e.text)), 'chef log has the main-thread step');
});

test('GET /cook and GET /chef reject a foreign Host header with 403', async () => {
  const s = k.kitchenSession();
  await s.prompt();
  await s.start('h1', LINE);
  const q = `session=${encodeURIComponent(s.id)}`;
  assert.equal((await k.request({ path: `/cook?${q}&id=h1` })).status, 200, 'control');
  assert.equal((await k.request({ path: `/chef?${q}` })).status, 200, 'control');
  const host = { host: `evil.example:${k.port}` };
  assert.equal((await k.request({ path: `/cook?${q}&id=h1`, headers: host })).status, 403);
  assert.equal((await k.request({ path: `/chef?${q}`, headers: host })).status, 403);
  assert.equal((await k.request({ path: `/events?${q}`, headers: host })).status, 403);
});

test('GET /state still returns every session with full prompt, report and logs', async () => {
  const s = k.kitchenSession();
  await s.prompt('state detail');
  const prompt = 'x'.repeat(3000), report = 'y'.repeat(3500);
  await s.call('tu1', LINE, 'State ticket', prompt);
  await s.start('s1', LINE);
  await s.ret('tu1', { agentId: 's1' });
  for (let i = 0; i < 22; i++) await s.tool('s1', LINE, 'Read', { file_path: `f${i}.txt` });
  await s.finish('s1', LINE, report);
  const c = await s.cook('s1');
  assert.equal(c.prompt, prompt);
  assert.equal(c.report, report);
  assert.equal(c.log.length, 20);
  assert.ok(!('guessCall' in c));
});

test('effort: a cook takes effort.level from its latest event carrying one; the chef from main-thread events', async () => {
  const s = k.kitchenSession();
  await s.prompt('effort');
  await s.start('e1', LINE);
  const ctool = (effort, file) => s.send('PreToolUse', { agent_id: 'e1', agent_type: LINE, tool_name: 'Read', tool_input: { file_path: file }, ...(effort ? { effort } : {}) });
  await ctool({ level: 'high' }, 'a');
  assert.equal((await s.cook('e1')).effort, 'high');
  await ctool(null, 'b');
  assert.equal((await s.cook('e1')).effort, 'high', 'an event without effort keeps the last one');
  await ctool({ level: 'low' }, 'c');
  assert.equal((await s.cook('e1')).effort, 'low');
  let st = await s.get();
  assert.equal(st.chef.effort, '', "a cook's effort is not the chef's");
  await s.send('PreToolUse', { tool_name: 'Read', tool_input: { file_path: 'm' }, effort: { level: 'xhigh' } });
  st = await s.get();
  assert.equal(st.chef.effort, 'xhigh');
  assert.equal(st.cooks.find(c => c.id === 'e1').effort, 'low', "the chef's effort is not the cook's");
  await s.send('PostToolUse', { tool_name: 'Read', tool_use_id: 'r', tool_input: {}, tool_response: {} });
  assert.equal((await s.get()).chef.effort, 'xhigh', 'kept without a new level');
  await s.send('Stop', { effort: { level: 'medium' } });
  assert.equal((await s.get()).chef.effort, 'medium');
});
