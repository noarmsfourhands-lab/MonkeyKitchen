// Reads back what a restarted server lost: the latest order and the cooks working on it, from the transcript files
// Claude Code keeps on disk. Best effort and read-only: whatever looks unexpected is skipped, nothing here throws.
//
//   <transcript>.jsonl                          the main thread; only its tail, back to the latest real prompt, is read
//   <transcript>/subagents/agent-<id>.jsonl     one cook's own transcript
//   <transcript>/subagents/agent-<id>.meta.json {agentType, description, toolUseId, ...}
//
// Files are read in chunks with a yield between them, so a long transcript never holds the event loop for long.

import fsp from 'node:fs/promises';
import path from 'node:path';

const CHUNK = 1024 * 1024;
const MAIN_TAIL_MAX = 64 * 1024 * 1024; // how far back from the end the latest prompt is looked for
const SUB_TAIL_MAX = 32 * 1024 * 1024; // a larger cook transcript is read from this far before its end
const HEAD_MAX = 4 * 1024 * 1024; // a cook transcript's first record longer than this is not read
const LINE_MAX = 8 * 1024 * 1024; // a longer record (a pasted file, a huge tool result) is skipped
const META_MAX = 64 * 1024;
const MAX_COOKS = 40;
const LOG_KEEP = 20;
const QUIET_DONE_MS = 30000; // a cook transcript untouched this long whose last word was not a tool call is done
const AGENT_FILE = /^agent-([A-Za-z0-9_-]{1,128})\.jsonl$/;
const HANDBACK_TOOL = 'SubagentHandback';
const REPORT_KEEP = 16000; // the server clips reports to 4000, as it does live ones
const tick = () => new Promise(r => setImmediate(r));
const ts = v => { const n = typeof v === 'string' ? Date.parse(v) : NaN; return Number.isFinite(n) ? n : null; };
const parse = line => { try { const r = JSON.parse(line); return r && typeof r === 'object' ? r : null; } catch { return null; } };
const blocks = rec => (Array.isArray(rec?.message?.content) ? rec.message.content.filter(b => b && typeof b === 'object') : []);
const textOf = content => typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n') : '';

async function readAt(fh, buf, pos) {
  let got = 0;
  while (got < buf.length) {
    const { bytesRead } = await fh.read(buf, got, buf.length - got, pos + got);
    if (!bytesRead) break;
    got += bytesRead;
  }
  return got === buf.length ? buf : buf.subarray(0, got);
}

// Calls fn(line) for each line from the end of the file backwards, at most maxBytes back; fn returns true to stop.
// A line longer than LINE_MAX is skipped rather than buffered.
async function eachLineBackward(file, maxBytes, fn) {
  const fh = await fsp.open(file, 'r');
  try {
    const { size } = await fh.stat();
    let pos = size, carry = Buffer.alloc(0), read = 0, skipping = false;
    while (pos > 0 && read < maxBytes) {
      const n = Math.min(CHUNK, pos);
      pos -= n; read += n;
      let data = await readAt(fh, Buffer.alloc(n), pos);
      if (skipping) {
        // Everything after this chunk's last newline is the start of the skipped line.
        const end = data.lastIndexOf(10);
        if (end < 0) { await tick(); continue; }
        data = data.subarray(0, end); skipping = false;
      } else if (carry.length) data = Buffer.concat([data, carry]);
      let from = 0;
      if (pos > 0) {
        const nl = data.indexOf(10);
        if (nl < 0) { // still inside one long line
          if (data.length > LINE_MAX) { carry = Buffer.alloc(0); skipping = true; } else carry = Buffer.from(data);
          await tick(); continue;
        }
        carry = Buffer.from(data.subarray(0, nl)); // the start of this line is in the next chunk back
        from = nl + 1;
      } else carry = Buffer.alloc(0);
      const lines = data.subarray(from).toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) if (lines[i] && fn(lines[i]) === true) return;
      await tick();
    }
  } finally { await fh.close(); }
}

// Calls fn(line) for each complete line from byte `start` to `size`. A line longer than LINE_MAX is skipped.
async function eachLineForward(file, start, size, fn) {
  const fh = await fsp.open(file, 'r');
  try {
    let pos = start, rest = Buffer.alloc(0), skipping = start > 0; // reading from mid-file: the first piece is a partial line
    while (pos < size) {
      const got = await readAt(fh, Buffer.alloc(Math.min(CHUNK, size - pos)), pos);
      if (!got.length) break;
      pos += got.length;
      let data = got;
      if (skipping) {
        const nl = data.indexOf(10);
        if (nl < 0) { await tick(); continue; }
        data = data.subarray(nl + 1); skipping = false;
      } else if (rest.length) data = Buffer.concat([rest, data]);
      const last = data.lastIndexOf(10);
      if (last >= 0) for (const line of data.subarray(0, last).toString('utf8').split('\n')) if (line) fn(line);
      const tail = last >= 0 ? data.subarray(last + 1) : data;
      if (tail.length > LINE_MAX) { rest = Buffer.alloc(0); skipping = true; } else rest = Buffer.from(tail);
      await tick();
    }
    if (rest.length && !skipping) fn(rest.toString('utf8')); // the last line, if complete, still parses
  } finally { await fh.close(); }
}

async function firstLine(file) {
  const fh = await fsp.open(file, 'r');
  try {
    let pos = 0, acc = Buffer.alloc(0);
    while (pos < HEAD_MAX) {
      const got = await readAt(fh, Buffer.alloc(Math.min(CHUNK, HEAD_MAX - pos)), pos);
      if (!got.length) return acc.length ? acc.toString('utf8') : null;
      pos += got.length;
      acc = Buffer.concat([acc, got]);
      const nl = acc.indexOf(10);
      if (nl >= 0) return acc.subarray(0, nl).toString('utf8');
    }
    return null;
  } finally { await fh.close(); }
}

async function readMeta(file) {
  try {
    const st = await fsp.stat(file);
    if (!st.isFile() || st.size > META_MAX) return {};
    const j = JSON.parse(await fsp.readFile(file, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch { return {}; }
}

// The main transcript's tail: the latest real prompt, the Agent calls made after it, and whether that turn has ended.
async function readMain(file, promptOf, now) {
  const st = await fsp.stat(file);
  if (!st.isFile()) return null;
  const calls = new Map();
  // Proof a cook has finished: its Agent call returned (not merely launched in the background), or it handed back.
  const returned = new Set(), handedBack = new Set();
  let order = null, latest = null; // latest: the newest user or assistant record of the main thread
  await eachLineBackward(file, MAIN_TAIL_MAX, line => {
    const isUser = line.includes('"type":"user"'), isAssistant = line.includes('"type":"assistant"');
    if (!isUser && !isAssistant) return false;
    const rec = parse(line);
    if (!rec || rec.isSidechain === true || (rec.type !== 'user' && rec.type !== 'assistant')) return false;
    if (!latest && !rec.isMeta) latest = rec;
    if (rec.type === 'assistant') {
      for (const b of blocks(rec)) {
        if (b.type === 'tool_use' && (b.name === 'Agent' || b.name === 'Task') && typeof b.id === 'string' && b.input && typeof b.input === 'object' && !calls.has(b.id)) calls.set(b.id, b.input);
      }
      return false;
    }
    const res = rec.toolUseResult && typeof rec.toolUseResult === 'object' ? rec.toolUseResult : null;
    const launched = res && (res.isAsync === true || /async|launched|running/i.test(String(res.status ?? '')));
    if (!launched) for (const b of blocks(rec)) if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') returned.add(b.tool_use_id);
    const o = rec.origin && typeof rec.origin === 'object' ? rec.origin : null;
    if (o?.kind === 'peer' && o.handback === true && typeof o.from === 'string') handedBack.add(o.from);
    const text = promptOf(rec);
    const at = ts(rec.timestamp);
    if (text == null || at == null) return false;
    order = { text, at };
    return true;
  });
  if (!order) return null;
  // The turn ended when the thread's last word was the assistant's and not a tool call, and the file has settled.
  const settled = now - st.mtimeMs > QUIET_DONE_MS;
  const served = settled && latest?.type === 'assistant' && !blocks(latest).some(b => b.type === 'tool_use') && latest?.message?.stop_reason !== 'tool_use';
  return { order: { ...order, served }, calls, returned, handedBack };
}

// One cook transcript, from its first record (start time, prompt) to its last (model, steps, report, status).
async function readCook(file, size, mtimeMs, describe, now, promptAt) {
  const head = parse(await firstLine(file));
  const startedAt = ts(head?.timestamp);
  // Started before the order (or undatable): it belongs to an earlier one.
  if (startedAt == null || startedAt < promptAt) return null;
  const firstPrompt = head?.type === 'user' ? textOf(head.message?.content) : '';
  const seen = new Set();
  const log = [];
  let tools = 0, model = '', lastText = '', lastTextId = null, last = null;
  // A background cook ends by calling SubagentHandback with its report as input.message. Handed back, it is done,
  // unless it was then sent a new message or went on with other tools (it was resumed; a later hand-back ends that).
  let handedBack = false, everHandedBack = false, handback = '';
  await eachLineForward(file, Math.max(0, size - SUB_TAIL_MAX), size, line => {
    if (!line.includes('"type":"assistant"') && !line.includes('"type":"user"')) return;
    const rec = parse(line);
    if (!rec || (rec.type !== 'assistant' && rec.type !== 'user')) return;
    if (!rec.isMeta) last = rec;
    if (rec.type !== 'assistant') {
      if (handedBack && !rec.isMeta && textOf(rec.message?.content).trim()) handedBack = false;
      return;
    }
    const m = rec.message?.model;
    if (typeof m === 'string' && m && !m.startsWith('<')) model = m;
    const t = ts(rec.timestamp) ?? startedAt;
    for (const b of blocks(rec)) {
      if (b.type === 'tool_use') {
        const key = typeof b.id === 'string' ? b.id : null;
        if (key && seen.has(key)) continue;
        if (key) { seen.add(key); if (seen.size > 5000) seen.delete(seen.values().next().value); }
        if (b.name === HANDBACK_TOOL) {
          handedBack = true; everHandedBack = true;
          const msg = b.input && typeof b.input === 'object' ? b.input.message : null;
          handback = typeof msg === 'string' ? msg.slice(0, REPORT_KEEP) : '';
        } else handedBack = false;
        // Counted as a step like any tool call: live, its PreToolUse counts it too.
        tools++;
        const [kind, text] = describe(b.name, b.input);
        log.push({ t, kind, text });
        if (log.length > LOG_KEEP) log.shift();
      } else if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        // One response is written as several records sharing a message id: its text blocks belong together.
        const id = rec.message?.id ?? null;
        lastText = id != null && id === lastTextId ? `${lastText}\n${b.text}` : b.text;
        lastTextId = id;
      }
    }
  });
  // The hand-back call is conclusive, and its message is the report; without one, the quiet-file guess and the
  // last assistant text.
  if (handedBack) return { startedAt, firstPrompt, tools, log, model, done: true, handedBack: true, resumed: false, lastText: handback || lastText };
  const done = now - mtimeMs > QUIET_DONE_MS && last?.type === 'assistant' && !blocks(last).some(b => b.type === 'tool_use');
  // Handed back once and then resumed: an earlier hand-back seen in the main thread no longer means done.
  return { startedAt, firstPrompt, tools, log, model, done, handedBack: false, resumed: everHandedBack, lastText };
}

// promptOf(record) -> the order text of a real user prompt, or null; describe(tool, input) -> [kind, text].
// Returns null, or { order: {text, at, served}, cooks: [...] } with cooks newest first.
export async function readBack(transcriptPath, { promptOf, describe, now = Date.now() }) {
  let main;
  try { main = await readMain(transcriptPath, promptOf, now); } catch { return null; }
  if (!main) return null;
  const promptAt = main.order.at;
  const subDir = path.join(transcriptPath.replace(/\.jsonl$/i, ''), 'subagents');
  let names = [];
  try { names = await fsp.readdir(subDir); } catch { /* no cooks */ }
  const found = [];
  for (const name of names) {
    const m = AGENT_FILE.exec(name);
    if (!m) continue;
    try {
      const file = path.join(subDir, name);
      const st = await fsp.stat(file);
      // Not written since the prompt: it cannot have started after it.
      if (!st.isFile() || st.mtimeMs < promptAt) continue;
      found.push({ id: m[1], file, size: st.size, mtimeMs: st.mtimeMs });
    } catch { /* gone */ }
  }
  // Most recently written first, so the cap keeps the newest cooks.
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const cooks = [];
  for (const f of found) {
    if (cooks.length >= MAX_COOKS) break;
    try {
      const r = await readCook(f.file, f.size, f.mtimeMs, describe, now, promptAt);
      if (!r) continue;
      const meta = await readMeta(path.join(subDir, `agent-${f.id}.meta.json`));
      const call = typeof meta.toolUseId === 'string' ? main.calls.get(meta.toolUseId) : null;
      // Real evidence first (its call returned, or it handed back); else the guess from its own transcript.
      // A hand-back call in its own transcript is conclusive. A cook resumed after handing back is judged by its own
      // transcript alone: the main thread's record of the earlier hand-back is out of date.
      const mainSaysDone = (typeof meta.toolUseId === 'string' && main.returned.has(meta.toolUseId)) || main.handedBack.has(f.id);
      const done = r.handedBack || (!r.resumed && mainSaysDone) || r.done;
      const str = v => (typeof v === 'string' ? v : '');
      cooks.push({
        id: f.id,
        agentType: str(meta.agentType) || str(call?.subagent_type),
        description: str(meta.description) || str(call?.description),
        prompt: str(call?.prompt) || r.firstPrompt,
        model: r.model, tools: r.tools, log: r.log, startedAt: r.startedAt, lastAt: f.mtimeMs,
        status: done ? 'done' : 'working', report: done ? r.lastText : '',
      });
    } catch { /* skip this cook */ }
    await tick();
  }
  cooks.sort((a, b) => b.startedAt - a.startedAt);
  return { order: main.order, cooks: cooks.slice(0, MAX_COOKS) };
}
