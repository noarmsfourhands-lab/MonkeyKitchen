// Token meter. Reads the session transcript and its subagent transcripts
// (JSONL files Claude Code writes) and totals usage per model tier.
// Files are read incrementally, so re-scanning a long session stays cheap.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PRICING = JSON.parse(fs.readFileSync(path.join(here, 'pricing.json'), 'utf8')).perMillionTokens;
const TIER_ORDER = ['fable', 'opus', 'sonnet', 'haiku', 'other'];
const RECENT_MESSAGES = 2000;
const KEYS = ['input', 'output', 'cacheRead', 'cacheWrite'];

export function tierOf(model = '') {
  const m = model.toLowerCase();
  if (m.includes('fable') || m.includes('mythos')) return 'fable';
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  return 'other';
}

function costOf(tier, t) {
  const p = PRICING[tier];
  if (!p) return 0;
  return (t.input * p.input + t.output * p.output + t.cacheRead * p.cacheRead + t.cacheWrite * p.cacheWrite) / 1e6;
}

const tokens = u => ({ input: u.input_tokens || 0, output: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0 });

class TranscriptFile {
  constructor(file) {
    this.file = file;
    this.offset = 0;
    this.rest = Buffer.alloc(0);
    this.totals = {}; // tier -> running token totals
    this.recent = new Map(); // message id -> { tier, n }: what was counted, so a later record can replace it
    this.lastModel = null;
  }

  bump(tier, n, sign) {
    const t = (this.totals[tier] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    for (const k of KEYS) t[k] += sign * n[k];
  }

  async readNew() {
    let st;
    try { st = await fsp.stat(this.file); } catch { return; }
    if (st.size < this.offset) { this.offset = 0; this.rest = Buffer.alloc(0); this.totals = {}; this.recent.clear(); }
    if (st.size === this.offset) return;
    const buf = Buffer.alloc(st.size - this.offset);
    const fh = await fsp.open(this.file, 'r');
    try { await fh.read(buf, 0, buf.length, this.offset); } finally { await fh.close(); }
    this.offset = st.size;
    const data = Buffer.concat([this.rest, buf]);
    const lastNl = data.lastIndexOf(10);
    if (lastNl < 0) { this.rest = data; return; }
    this.rest = data.subarray(lastNl + 1);
    for (const line of data.subarray(0, lastNl).toString('utf8').split('\n')) {
      if (!line.includes('"usage"')) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      const msg = rec.message;
      if (rec.type !== 'assistant' || !msg?.usage || typeof msg.model !== 'string' || !msg.model || msg.model.startsWith('<')) continue;
      // One API response is written as several records sharing a message id,
      // each repeating the usage block, the later ones final. Count it once, the latest.
      const id = msg.id || rec.uuid;
      const old = this.recent.get(id);
      if (old) { this.bump(old.tier, old.n, -1); this.recent.delete(id); }
      const tier = tierOf(msg.model), n = tokens(msg.usage);
      this.bump(tier, n, 1);
      this.recent.set(id, { tier, n });
      if (this.recent.size > RECENT_MESSAGES) this.recent.delete(this.recent.keys().next().value);
      this.lastModel = msg.model;
    }
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
    for (const p of paths) {
      if (!this.files.has(p)) this.files.set(p, new TranscriptFile(p));
      const tf = this.files.get(p);
      await tf.readNew();
      for (const [tier, n] of Object.entries(tf.totals)) {
        const t = (totals[tier] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
        for (const k of KEYS) t[k] += n[k];
      }
      const m = path.basename(p).match(/^agent-(.+)\.jsonl$/);
      if (m && tf.model) agents[m[1]] = { model: tf.model, tier: tierOf(tf.model) };
    }

    const tiers = TIER_ORDER.filter(k => totals[k]).map(k => ({ tier: k, ...totals[k], cost: costOf(k, totals[k]) }));
    if (!tiers.length) return null;
    const sum = key => tiers.reduce((a, t) => a + t[key], 0);
    const total = { input: sum('input'), output: sum('output'), cacheRead: sum('cacheRead'), cacheWrite: sum('cacheWrite'), cost: sum('cost') };
    // "Solo" estimate: the same tokens, all priced at the main session's tier.
    const mainModel = this.files.get(this.transcriptPath)?.model || '';
    const mainTier = tierOf(mainModel);
    const soloCost = PRICING[mainTier] ? costOf(mainTier, total) : 0;
    return { tiers, total, mainTier, mainModel, soloCost, agents };
  }
}
