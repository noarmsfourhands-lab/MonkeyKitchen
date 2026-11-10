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

class TranscriptFile {
  constructor(file) {
    this.file = file;
    this.offset = 0;
    this.rest = Buffer.alloc(0);
    this.messages = new Map(); // message id -> { model, usage }
    this.lastModel = null;
  }

  async readNew() {
    let st;
    try { st = await fsp.stat(this.file); } catch { return; }
    if (st.size < this.offset) { this.offset = 0; this.rest = Buffer.alloc(0); this.messages.clear(); }
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
      if (rec.type !== 'assistant' || !msg?.usage || !msg.model || msg.model.startsWith('<')) continue;
      // One API response is written as several records sharing a message id,
      // each repeating the usage block. Keep the latest, count it once.
      this.messages.set(msg.id || rec.uuid, { model: msg.model, usage: msg.usage });
      this.lastModel = msg.model;
    }
  }
}

export class UsageMeter {
  constructor(transcriptPath) {
    this.transcriptPath = transcriptPath;
    this.files = new Map();
  }

  async scan() {
    if (!this.transcriptPath) return null;
    const paths = [this.transcriptPath];
    const subDir = path.join(this.transcriptPath.replace(/\.jsonl$/i, ''), 'subagents');
    try {
      for (const f of await fsp.readdir(subDir)) if (f.endsWith('.jsonl')) paths.push(path.join(subDir, f));
    } catch { /* no subagents yet */ }

    const totals = {};
    for (const p of paths) {
      if (!this.files.has(p)) this.files.set(p, new TranscriptFile(p));
      const tf = this.files.get(p);
      await tf.readNew();
      for (const { model, usage } of tf.messages.values()) {
        const t = (totals[tierOf(model)] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
        t.input += usage.input_tokens || 0;
        t.output += usage.output_tokens || 0;
        t.cacheRead += usage.cache_read_input_tokens || 0;
        t.cacheWrite += usage.cache_creation_input_tokens || 0;
      }
    }

    const tiers = TIER_ORDER.filter(k => totals[k]).map(k => ({ tier: k, ...totals[k], cost: costOf(k, totals[k]) }));
    if (!tiers.length) return null;
    const sum = key => tiers.reduce((a, t) => a + t[key], 0);
    const total = { input: sum('input'), output: sum('output'), cacheRead: sum('cacheRead'), cacheWrite: sum('cacheWrite'), cost: sum('cost') };
    // "Solo" estimate: the same tokens, all priced at the main session's tier.
    const mainTier = tierOf(this.files.get(this.transcriptPath)?.lastModel || '');
    const soloCost = PRICING[mainTier] ? costOf(mainTier, total) : 0;
    return { tiers, total, mainTier, soloCost };
  }
}
