// Token meter. Reads the session transcript and its subagent transcripts
// (JSONL files Claude Code writes) and totals usage and cost per model tier.
// Each message is priced at its own model's rate (pricing.json).
// Files are read incrementally and in chunks, so re-scanning a long session stays cheap
// and a first scan of a huge one never blocks the event loop for long.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// Built-in copy of pricing.json's tier rates: a broken pricing.json must not stop the kitchen.
const DEFAULT_PRICING = {
  models: {},
  tiers: {
    fable: { input: 8, output: 40, cacheRead: 0.2, cacheWrite5m: 10, cacheWrite1h: 16, fast: 2 },
    opus: { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8, fast: 2 },
    sonnet: { input: 2, output: 10, cacheRead: 0.1, cacheWrite5m: 2.5, cacheWrite1h: 4 },
    haiku: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite5m: 0.125, cacheWrite1h: 0.2 },
  },
};
function loadPricing() {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(here, 'pricing.json'), 'utf8'));
    if (!p || typeof p.tiers !== 'object' || !p.tiers) throw new Error('no "tiers" section');
    return { models: p.models && typeof p.models === 'object' ? p.models : {}, tiers: p.tiers };
  } catch (e) {
    console.warn(`Monkey Kitchen: server/pricing.json unusable (${e.message}); using built-in prices.`);
    return DEFAULT_PRICING;
  }
}
const PRICING = loadPricing();
const PREFIXES = Object.keys(PRICING.models).map(k => k.toLowerCase()).sort((a, b) => b.length - a.length);
const TIER_ORDER = ['fable', 'opus', 'sonnet', 'haiku', 'other'];
const RECENT_MESSAGES = 2000;
const CHUNK = 4 * 1024 * 1024;
const MAX_LINE = 64 * 1024 * 1024; // a longer line is skipped rather than buffered
const KEYS = ['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite5m', 'cacheWrite1h'];
const RATE_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h'];
const zero = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, cost: 0 });
const tick = () => new Promise(r => setImmediate(r));

export function tierOf(model = '') {
  const m = String(model || '').toLowerCase();
  if (m.includes('fable') || m.includes('mythos')) return 'fable';
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  return 'other';
}

// The rate card for a model id: the longest listed id it equals or extends with a date ("-20251001") or a "[...]"
// suffix, else its tier's current rate, else null. An unreleased "claude-fable-5-3" is not "claude-fable-5".
const extendsId = (m, k) => m === k || (m.startsWith(k) && /^(-\d{8}(?!\d)|\[)/.test(m.slice(k.length)));
export function priceOf(model = '') {
  const m = String(model || '').toLowerCase();
  const hit = PREFIXES.find(k => extendsId(m, k));
  if (hit) return Object.entries(PRICING.models).find(([k]) => k.toLowerCase() === hit)[1];
  return PRICING.tiers[tierOf(m)] || null;
}

// Cost of a token count at a rate card; `fast` applies the card's fast-mode multiplier.
function costOf(p, t, fast = false) {
  if (!p) return 0;
  let c = 0;
  for (const k of RATE_KEYS) c += (t[k] || 0) * (Number(p[k]) || 0);
  return (c / 1e6) * (fast ? Number(p.fast) || 1 : 1);
}

function tokens(u) {
  const cc = u.cache_creation && typeof u.cache_creation === 'object' ? u.cache_creation : null;
  const w5 = cc ? Number(cc.ephemeral_5m_input_tokens) || 0 : Number(u.cache_creation_input_tokens) || 0;
  const w1 = cc ? Number(cc.ephemeral_1h_input_tokens) || 0 : 0;
  return { input: Number(u.input_tokens) || 0, output: Number(u.output_tokens) || 0, cacheRead: Number(u.cache_read_input_tokens) || 0, cacheWrite: w5 + w1, cacheWrite5m: w5, cacheWrite1h: w1 };
}

class TranscriptFile {
  constructor(file) {
    this.file = file;
    this.reset();
  }

  reset() {
    this.offset = 0;
    this.rest = Buffer.alloc(0);
    this.skipping = false; // inside a line too long to buffer
    this.totals = {}; // tier -> running token and cost totals
    this.std = zero(); // all tokens billed at the standard rate (for the solo estimate)
    this.fast = zero(); // all tokens billed in fast mode
    this.recent = new Map(); // message id -> what was counted, so a later record can replace it
    this.lastModel = null;
  }

  bump(m, sign) {
    const t = (this.totals[m.tier] ??= zero());
    const s = m.fast ? this.fast : this.std;
    for (const k of KEYS) { t[k] += sign * m.n[k]; s[k] += sign * m.n[k]; }
    t.cost += sign * m.cost;
  }

  parse(text) {
    for (const line of text.split('\n')) {
      if (!line.includes('"usage"')) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      const msg = rec?.message;
      if (rec.type !== 'assistant' || !msg?.usage || typeof msg.model !== 'string' || !msg.model || msg.model.startsWith('<')) continue;
      // One API response is written as several records sharing a message id,
      // each repeating the usage block, the later ones final. Count it once, the latest.
      const id = msg.id || rec.uuid;
      const old = this.recent.get(id);
      if (old) { this.bump(old, -1); this.recent.delete(id); }
      const n = tokens(msg.usage), fast = msg.usage.speed === 'fast';
      const m = { tier: tierOf(msg.model), n, fast, cost: costOf(priceOf(msg.model), n, fast) };
      this.bump(m, 1);
      this.recent.set(id, m);
      if (this.recent.size > RECENT_MESSAGES) this.recent.delete(this.recent.keys().next().value);
      this.lastModel = msg.model;
    }
  }

  async readNew() {
    let st;
    try { st = await fsp.stat(this.file); } catch { return; }
    if (st.size < this.offset) this.reset();
    if (st.size === this.offset) return;
    const fh = await fsp.open(this.file, 'r');
    try {
      const buf = Buffer.alloc(Math.min(CHUNK, st.size - this.offset));
      while (this.offset < st.size) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, st.size - this.offset), this.offset);
        if (!bytesRead) break;
        let data = buf.subarray(0, bytesRead);
        if (this.skipping) {
          const nl = data.indexOf(10);
          if (nl < 0) { this.offset += bytesRead; await tick(); continue; }
          this.skipping = false; data = data.subarray(nl + 1);
        }
        data = this.rest.length ? Buffer.concat([this.rest, data]) : data;
        const lastNl = data.lastIndexOf(10);
        if (lastNl >= 0) this.parse(data.subarray(0, lastNl).toString('utf8'));
        // Keep the unfinished tail (copied: buf is reused) unless it is already absurdly long.
        const tail = lastNl >= 0 ? data.subarray(lastNl + 1) : data;
        if (tail.length > MAX_LINE) { this.rest = Buffer.alloc(0); this.skipping = true; } else this.rest = Buffer.from(tail);
        // Only now are this chunk's bytes accounted for: a failed read above leaves them for the next scan.
        this.offset += bytesRead;
        if (this.offset < st.size) await tick();
      }
    } finally { await fh.close(); }
  }

  get model() { return this.lastModel; }
}

export class UsageMeter {
  constructor(transcriptPath) {
    this.transcriptPath = transcriptPath;
    this.files = new Map();
    this.chain = Promise.resolve();
  }

  // Scans never overlap: one asked for mid-scan waits its turn.
  scan() {
    const run = this.chain.then(() => this.#scan());
    this.chain = run.catch(() => {});
    return run;
  }

  async #scan() {
    if (!this.transcriptPath) return null;
    const paths = [this.transcriptPath];
    const subDir = path.join(this.transcriptPath.replace(/\.jsonl$/i, ''), 'subagents');
    try {
      for (const f of await fsp.readdir(subDir)) if (f.endsWith('.jsonl')) paths.push(path.join(subDir, f));
    } catch { /* no subagents yet */ }

    const totals = {};
    const agents = {};
    const std = zero(), fast = zero();
    for (const p of paths) {
      if (!this.files.has(p)) this.files.set(p, new TranscriptFile(p));
      const tf = this.files.get(p);
      await tf.readNew();
      for (const [tier, n] of Object.entries(tf.totals)) {
        const t = (totals[tier] ??= zero());
        for (const k of [...KEYS, 'cost']) t[k] += n[k];
      }
      for (const k of KEYS) { std[k] += tf.std[k]; fast[k] += tf.fast[k]; }
      const m = path.basename(p).match(/^agent-(.+)\.jsonl$/);
      if (m && tf.model) agents[m[1]] = { model: tf.model, tier: tierOf(tf.model) };
    }

    const tiers = TIER_ORDER.filter(k => totals[k]).map(k => ({ tier: k, ...totals[k] }));
    if (!tiers.length) return null;
    const sum = key => tiers.reduce((a, t) => a + t[key], 0);
    const total = { input: sum('input'), output: sum('output'), cacheRead: sum('cacheRead'), cacheWrite: sum('cacheWrite'), cacheWrite5m: sum('cacheWrite5m'), cacheWrite1h: sum('cacheWrite1h'), cost: sum('cost') };
    // "Solo" estimate: the same tokens, all priced at the main session's model (fast-mode tokens at its fast rate).
    const mainModel = this.files.get(this.transcriptPath)?.model || '';
    const mainTier = tierOf(mainModel);
    const main = mainModel ? priceOf(mainModel) : null;
    const soloCost = costOf(main, std) + costOf(main, fast, true);
    return { tiers, total, mainTier, mainModel, soloCost, agents };
  }
}
