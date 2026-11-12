// Monkey Kitchen front end. A small top-down simulation: every agent is a
// monkey that walks to the part of the kitchen matching what it is doing.
// State arrives as snapshots over /events; art.js does the drawing.

const ROLES = [
  { id: 'head-chef', name: 'Head Chef', tier: '' },
  { id: 'sous-chef', name: 'Sous Chef', tier: 'opus' },
  { id: 'chef-de-partie', name: 'Senior Cook', tier: 'opus' },
  { id: 'frontend-cook', name: 'Pastry Chef', tier: 'opus' },
  { id: 'backend-cook', name: 'Grill Cook', tier: 'opus' },
  { id: 'line-cook', name: 'Line Cook', tier: 'opus' },
  { id: 'taster', name: 'Taster', tier: 'opus' },
  { id: 'inspector', name: 'Health Inspector', tier: 'opus' },
  { id: 'prep-cook', name: 'Prep Cook', tier: 'opus' },
  { id: 'runner', name: 'Runner', tier: 'opus' },
  { id: 'dishwasher', name: 'Dishwasher', tier: 'opus' },
  { id: 'scribe', name: 'Menu Scribe', tier: 'opus' },
  { id: 'stagiaire', name: 'Stagiaire', tier: 'guest' },
];
const ROLE = Object.fromEntries(ROLES.map(r => [r.id, r]));
const TIER_LABEL = { fable: 'Fable', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', guest: 'Guest', other: 'Other' };
const TIER_COLOR = { fable: '#b77fd0', opus: '#f08a63', sonnet: '#5cc7c7', haiku: '#8fd17c', guest: '#b8b8b8', other: '#b8b8b8' };

// Where each kind of work happens. `spots` are the tiles a monkey stands on; `row` is the tile row of the
// furniture it faces there, which is where its particles and the "in use" drawing go.
const LOC = {
  shelf: { act: 'read', row: 2, spots: [[4, 3], [5, 3], [4, 4], [5, 4]] },
  pantry: { act: 'rummage', row: 2, spots: [[2, 3], [3, 3], [1, 3], [2, 4], [3, 4]] },
  sink: { act: 'wash', row: 2, spots: [[7, 3], [8, 3], [7, 4], [8, 4]] },
  board: { act: 'chop', row: 2, spots: [[9, 3], [10, 3], [9, 4], [10, 4]] },
  stove: { act: 'pan', row: 2, spots: [[11, 3], [12, 3], [11, 4], [12, 4]] },
  oven: { act: 'bake', row: 2, spots: [[13, 3], [13, 4]] },
  grill: { act: 'grill', row: 2, spots: [[14, 3], [15, 3], [14, 4], [15, 4]] },
  pastry: { act: 'pipe', row: 2, spots: [[16, 3], [17, 3], [16, 4], [17, 4]] },
  menu: { act: 'chalk', row: 1, spots: [[21, 2], [20, 2], [22, 2]] },  // the menu board hangs on the wall
  desk: { act: 'plan', row: 7, spots: [[1, 8], [2, 8]] },              // the desk is the row above its spots
  pot: { act: 'taste', row: 6, spots: [[9, 5], [10, 5]], face: 'down' },
  bowl: { act: 'whisk', row: 6, spots: [[12, 5], [13, 5], [14, 5]], face: 'down' },
  spuds: { act: 'peel', row: 6, spots: [[15, 7], [14, 7], [16, 7]] },  // the island, seen from below
};
for (const L of Object.values(LOC)) { const xs = L.spots.map(s => s[0]); L.minX = Math.min(...xs); L.maxX = Math.max(...xs); }
const STATION = {
  'prep-cook': 'board', 'backend-cook': 'grill', 'frontend-cook': 'pastry', 'line-cook': 'stove', dishwasher: 'sink',
  taster: 'pot', scribe: 'menu', 'sous-chef': 'desk', 'chef-de-partie': 'bowl', runner: 'pantry', stagiaire: 'spuds', inspector: 'patrol',
};
// Where each monkey waits between tickets: most on the break rug, a few dozing near their post.
const HOME = {
  'frontend-cook': [20, 5], 'backend-cook': [22, 5], 'line-cook': [20, 7], 'prep-cook': [22, 7],
  runner: [21, 6], dishwasher: [19, 6], scribe: [23, 7],
  'sous-chef': [3, 8], 'chef-de-partie': [5, 6], taster: [7, 6], inspector: [18, 8], stagiaire: [17, 6],
};
const DOOR = [0, 3], CHEF_SPOT = [11, 9];
const PLATE_SLOTS = [9, 14, 7, 16, 5, 18, 3, 20, 8, 15, 6, 17, 4, 19, 10, 13];
const FOODS = ['#e8792e', '#6cbf4b', '#f2a7c0', '#e7c94a', '#b5522c'];
const ARMS = new Set(['chop', 'pan', 'grill', 'pipe', 'wash', 'chalk', 'peel', 'rummage', 'place', 'ring', 'wave', 'plate', 'shout', 'bake', 'taste', 'whisk']);
const SPEED = 62; // world pixels per second
const FRAME_MS = 1000 / 30 - 2; // draw at about 30 frames per second
const QUIET_SWITCH_MS = 15000; // "Latest session" only moves off a session that has been still this long
// Tiles a crowd must not spill onto: every station spot, every home, the pass and the door.
const RESERVED = new Set([...Object.values(LOC).flatMap(l => l.spots), ...Object.values(HOME), CHEF_SPOT, DOOR].map(p => p.join()));

function locFor(role, kind) {
  if (kind === 'read') return 'shelf';
  if (kind === 'search') return 'pantry';
  if (kind === 'web') return 'trip';
  if (kind === 'run' && role === 'frontend-cook') return 'oven';
  return STATION[role] || 'spuds';
}

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = a => a[Math.floor(Math.random() * a.length)];
const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
let reduced = motionQuery.matches;
motionQuery.addEventListener('change', () => { reduced = motionQuery.matches; if (reduced) particles = []; });

// A cook's status, with the old server's "done but stale" read as what it means: quiet, not finished.
// Anything unknown or missing counts as working: only an explicit 'done' earns a plate. 'lost' is a cook that
// went quiet and never came back (an interrupt, say): ended, no plate.
const statusOf = c => c.status === 'quiet' || (c.status === 'done' && c.stale) ? 'quiet' : c.status === 'done' || c.status === 'failed' || c.status === 'lost' ? c.status : 'working';
const endText = st => st === 'failed' ? 'Sent back' : st === 'lost' ? 'Never reported back' : 'Plated';
const isBusy = c => { const st = statusOf(c); return st === 'working' || st === 'quiet'; };

// Tiers: what the server measured, or the role's usual tier marked with "?" so a guess looks like one.
const tierOf = t => ({ tier: t, label: TIER_LABEL[t] || t });
const guessTier = role => { const t = (ROLE[role] || ROLE.stagiaire).tier; return t ? { tier: t, label: (TIER_LABEL[t] || t) + '?' } : null; };
const cookTier = c => c.tier ? tierOf(c.tier) : guessTier(c.role);
const chefTier = s => s && s.usage && s.usage.mainTier ? tierOf(s.usage.mainTier) : null;
// The chip shows the tier, the effort, or both ("Opus · high"); with neither known there is no chip.
const chipLabel = (ti, effort) => ti ? ti.label + (effort ? ' · ' + effort : '') : effort || '';

// ---------- show more / show less ----------
// makeClamp(el, lines, key) turns a text element into one that is cut to `lines` lines, with a real
// button after it that appears only when the text actually overflows. The open/closed state lives in
// clampOpen under `key`, so it survives re-renders; c.set(text) changes the text, c.fit() re-measures.
// An element that already holds its text (markup, not set()) is registered with that text.
const clampOpen = new Set(), clamps = new Set();
function makeClamp(el, lines, key) {
  el.classList.add('clamp-text'); el.style.setProperty('--lines', lines);
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'clamp-btn'; btn.hidden = true;
  el.after(btn);
  const c = {
    el, btn, key, text: el.textContent, over: false, dirty: true,
    set(v) {
      v = v == null ? '' : String(v);
      if (v === c.text) return;
      c.text = v; el.textContent = v;
      if (!v) { c.over = false; c.dirty = false; el.classList.remove('expanded'); btn.hidden = true; return; }
      fitLater(c);
    },
    fit() {
      if (!el.clientWidth) { c.dirty = true; return; } // hidden right now: fitted again when it shows
      const top = el.scrollTop;
      el.classList.remove('expanded');
      const t = c.apply(el.scrollHeight > el.clientHeight + 1);
      if (t) el.scrollTop = top;
    },
    apply(over) { // the writes half of fit(); returns whether the text is shown expanded
      c.dirty = false; c.over = over;
      const exp = over && clampOpen.has(c.key);
      el.classList.toggle('expanded', exp);
      btn.hidden = !over;
      const label = exp ? 'Show less' : 'Show more';
      if (btn.textContent !== label) btn.textContent = label;
      btn.setAttribute('aria-expanded', exp);
      return exp;
    },
  };
  btn.addEventListener('click', ev => { ev.stopPropagation(); if (clampOpen.has(c.key)) clampOpen.delete(c.key); else clampOpen.add(c.key); c.fit(); });
  clamps.add(c);
  return c;
}
function dropClamp(c) { if (!c) return; clamps.delete(c); clampOpen.delete(c.key); }
function pruneClamps() { for (const c of clamps) if (!c.el.isConnected) clamps.delete(c); }
// Re-measure many clamps at once: all reads, then all writes, then all reads again, so the browser lays out twice, not once per clamp.
function fitAll(list) {
  const cs = [...list].filter(c => c.text && c.el.isConnected);
  const tops = cs.map(c => c.el.scrollTop);
  for (const c of cs) c.el.classList.remove('expanded');
  const over = cs.map(c => c.el.clientWidth ? c.el.scrollHeight > c.el.clientHeight + 1 : null);
  const exp = cs.map((c, i) => { if (over[i] === null) { c.dirty = true; return false; } return c.apply(over[i]); });
  cs.forEach((c, i) => { if (exp[i]) c.el.scrollTop = tops[i]; });
}
// While a batch is open (one snapshot being painted), clamps that change are collected and measured
// together by fitAll when it closes, instead of each forcing its own layout.
let clampBatch = null;
function batchClamps(fn) {
  if (clampBatch) return fn();
  const b = clampBatch = { list: new Set(), after: [] };
  try { return fn(); } finally { clampBatch = null; fitAll(b.list); b.after.forEach(f => f()); }
}
function fitLater(c) { if (clampBatch) { c.dirty = true; clampBatch.list.add(c); } else c.fit(); }
function afterFit(f) { if (clampBatch) clampBatch.after.push(f); else f(); }

// Puts `els` into `box` in that order, moving only the elements that are out of place: the longest run
// already in the right relative order stays put, so focus, scroll positions and open states inside it survive.
function placeInOrder(box, els) {
  const pos = new Map();
  let n = 0;
  for (let ch = box.firstElementChild; ch; ch = ch.nextElementSibling) pos.set(ch, n++);
  const idx = els.map(e => pos.has(e) ? pos.get(e) : -1);
  const keep = new Set(), len = idx.map(() => 0), prev = idx.map(() => -1);
  let best = -1;
  for (let j = 0; j < idx.length; j++) {
    if (idx[j] < 0) continue;
    len[j] = 1;
    for (let i = 0; i < j; i++) if (idx[i] >= 0 && idx[i] < idx[j] && len[i] + 1 > len[j]) { len[j] = len[i] + 1; prev[j] = i; }
    if (best < 0 || len[j] > len[best]) best = j;
  }
  for (let j = best; j >= 0; j = prev[j]) keep.add(j);
  const focused = document.activeElement;
  let next = null;
  for (let j = els.length - 1; j >= 0; j--) {
    if (!keep.has(j)) box.insertBefore(els[j], next);
    next = els[j];
  }
  if (focused && focused !== document.activeElement && focused.isConnected && box.contains(focused)) focused.focus({ preventScroll: true });
}

// Keeps a list of keyed rows patched in place (no rebuild, so scroll positions and open states survive).
// make(item, key) returns { el, clamp? }; only rows that are out of place are moved.
function patchList(box, items, keyOf, make) {
  const m = box._rows || (box._rows = new Map()), seen = new Set(), els = [];
  for (const it of items) {
    let k = keyOf(it);
    for (let n = 1; seen.has(k); n++) k = keyOf(it) + '#' + n;
    seen.add(k);
    let rec = m.get(k);
    if (!rec) { rec = make(it, k); m.set(k, rec); }
    els.push(rec.el);
  }
  for (const [k, rec] of m) if (!seen.has(k)) { rec.el.remove(); m.delete(k); dropClamp(rec.clamp); }
  placeInOrder(box, els);
  fitDirty(box);
}
function fitDirty(box) {
  if (!box._rows) return;
  const ds = [...box._rows.values()].map(r => r.clamp).filter(c => c && c.dirty);
  if (clampBatch) ds.forEach(c => clampBatch.list.add(c)); else fitAll(ds);
}

// ---------- walking ----------

function findPath(sx, sy, tx, ty) {
  if (sx === tx && sy === ty) return [];
  const key = (x, y) => y * COLS + x, prev = new Map([[key(sx, sy), -1]]), queue = [[sx, sy]];
  while (queue.length) {
    const [x, y] = queue.shift();
    for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
      const nx = x + dx, ny = y + dy, k = key(nx, ny);
      if (prev.has(k) || isBlocked(nx, ny)) continue;
      prev.set(k, key(x, y));
      if (nx === tx && ny === ty) {
        const path = [];
        for (let c = k; c !== key(sx, sy); c = prev.get(c)) path.unshift([c % COLS, Math.floor(c / COLS)]);
        return path;
      }
      queue.push([nx, ny]);
    }
  }
  return [];
}

// ---------- world ----------

let monkeys = [], particles = [], plates = [], claims = new Map(), byCook = new Map(), residents = new Map();
let chef, customer, customerPlate = false, chalk = 0, plateSlot = 0;

class Monkey {
  constructor(role, tx, ty) {
    this.role = role; this.x = tx * T; this.y = ty * T; this.dir = 'down';
    this.plan = []; this.i = 0; this.loop = false; this.intent = null; this.path = null; this.wait = 0;
    this.act = null; this.at = null; this.moving = false; this.hidden = false; this.carry = null;
    this.emote = null; this.emoteT = 0; this.cook = null; this.temp = false; this.gone = false; this.claim = null;
    this.t = Math.random() * 10; this.fx = 0; this.et = rnd(1, 3); this.label = null; this.sit = false;
    this.task = ''; this.ti = null; this.effort = ''; this.quiet = false;
  }
  setPlan(intent, steps, loop = false) {
    if (intent === this.intent) return;
    this.intent = intent; this.plan = steps; this.i = 0; this.loop = loop;
    this.path = null; this.wait = 0; this.act = null; this.hidden = false; this.sit = false;
  }
  say(kind, secs = 1.6) { this.emote = kind; this.emoteT = secs; }
  update(dt) {
    this.t += dt;
    if (this.emoteT > 0 && (this.emoteT -= dt) <= 0) this.emote = null;
    this.moving = false;
    for (let guard = 0; guard < 10; guard++) {
      if (this.i >= this.plan.length) { if (this.loop && this.plan.length) this.i = 0; else return; }
      const s = this.plan[this.i];
      if (s.go) {
        // with reduced motion an empty path means "jump straight there"
        if (!this.path) this.path = reduced ? [] : findPath(Math.round(this.x / T), Math.round(this.y / T), s.go[0], s.go[1]);
        if (!this.path.length) { this.x = s.go[0] * T; this.y = s.go[1] * T; if (s.face) this.dir = s.face; this.path = null; this.i++; continue; }
        const [nx, ny] = this.path[0], dx = nx * T - this.x, dy = ny * T - this.y, dist = Math.hypot(dx, dy), step = SPEED * dt;
        if (Math.abs(dx) > Math.abs(dy)) this.dir = dx < 0 ? 'left' : 'right'; else if (dy) this.dir = dy < 0 ? 'up' : 'down';
        if (dist <= step) { this.x = nx * T; this.y = ny * T; this.path.shift(); } else { this.x += dx / dist * step; this.y += dy / dist * step; }
        this.act = null; this.moving = true;
        return;
      }
      if (s.act) {
        this.act = s.act; this.at = s.at || null; if (s.sit) this.sit = true;
        if (!s.ms || this.quiet) return; // a quiet cook dozes where it stands
        if ((this.wait += dt) < s.ms / 1000) return;
        this.wait = 0; this.act = null; this.i++; continue;
      }
      if (s.hide) {
        this.hidden = true;
        if ((this.wait += dt) < s.hide / 1000) return;
        this.wait = 0; this.hidden = false; this.i++; continue;
      }
      if (s.set) Object.assign(this, s.set);
      if (s.emote) this.say(s.emote, s.secs);
      if (s.fn) s.fn(this);
      this.i++;
    }
  }
}

// Jumps a monkey to the end of its current plan (used when the tab comes back after being hidden).
function fastForward(e) {
  e.path = null; e.wait = 0; e.hidden = false; e.moving = false;
  for (let n = 0; n < 80; n++) {
    if (e.i >= e.plan.length) { if (e.loop) e.i = 0; return; }
    const s = e.plan[e.i];
    if (s.go) { e.x = s.go[0] * T; e.y = s.go[1] * T; if (s.face) e.dir = s.face; e.i++; continue; }
    if (s.act) { if (!s.ms) { e.act = s.act; e.at = s.at || null; if (s.sit) e.sit = true; return; } e.act = null; e.i++; continue; }
    if (s.hide) { e.i++; continue; }
    if (s.set) Object.assign(e, s.set);
    if (s.fn) s.fn(e);
    e.i++;
  }
}

function release(e) { if (e.claim && claims.get(e.claim) === e) claims.delete(e.claim); e.claim = null; }
function take(e, sp) { const k = sp.join(); claims.set(k, e); e.claim = k; return sp; }
function claimSpot(e, name) {
  release(e);
  const L = LOC[name];
  for (const sp of L.spots) if (!claims.has(sp.join())) return take(e, sp);
  // every spot taken: the nearest free walkable tile next to the station, so a crowd spreads out instead of stacking
  const near = nearFree(L.spots);
  if (near) return take(e, near);
  L.over = ((L.over || 0) + 1) % L.spots.length;
  return L.spots[L.over];
}
function nearFree(starts) {
  const seen = new Set(starts.map(p => p.join())), queue = starts.map(p => [p[0], p[1], 0]);
  while (queue.length) {
    const [x, y, d] = queue.shift();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy, k = nx + ',' + ny;
      if (seen.has(k) || isBlocked(nx, ny)) continue;
      seen.add(k);
      if (!claims.has(k) && !RESERVED.has(k)) return [nx, ny];
      if (d < 6) queue.push([nx, ny, d + 1]);
    }
  }
  return null;
}

function resetWorld() {
  monkeys = []; particles = []; plates = []; claims = new Map(); byCook = new Map(); residents = new Map();
  customerPlate = false; chalk = 0; plateSlot = 0;
  chef = new Monkey('head-chef', ...CHEF_SPOT); chef.label = 'Head Chef';
  customer = new Monkey('customer', MAP.table.x + .5, MAP.pass.y + 3); customer.dir = 'up';
  monkeys.push(chef, customer);
  ROLES.filter(r => r.id !== 'head-chef').forEach(r => {
    const e = new Monkey(r.id, ...HOME[r.id]); e.home = HOME[r.id];
    residents.set(r.id, e); monkeys.push(e);
  });
}

// ---------- plans ----------

// Plates only go on the pass while an order is cooking: not after the bell, not for a stopped order.
const orderCooking = () => !live || !live.order || live.order.status === 'cooking';
function addPlate(px, food) { plates.push({ x: px, food }); }
const nextSlot = () => PLATE_SLOTS[plateSlot++ % PLATE_SLOTS.length];

function idlePlan(e) {
  release(e);
  const onStool = STOOLS.some(([x, y]) => x === e.home[0] && y === e.home[1]);
  e.setPlan('idle', [{ set: { carry: null } }, { go: e.home, face: 'down' }, { act: e.home[0] % 2 ? 'snack' : 'nap', sit: onStool }]);
}
function exitPlan(e) {
  release(e);
  e.setPlan('exit', [{ set: { carry: null } }, { go: DOOR }, { fn: m => { m.gone = true; } }]);
}

function workPlan(e, role, kind) {
  const name = locFor(role, kind);
  const intent = 'work:' + name;
  if (e.intent === intent) return;
  if (name === 'trip') {
    const sp = claimSpot(e, 'pantry'), at = [clampN(sp[0], LOC.pantry.minX, LOC.pantry.maxX), LOC.pantry.row];
    e.setPlan(intent, [{ set: { carry: null } }, { go: DOOR, face: 'up' }, { hide: 1300 }, { set: { carry: 'crate' } }, { go: sp, face: 'up' },
      { act: 'rummage', ms: 900, at }, { set: { carry: null } }], true);
  } else if (name === 'patrol') {
    release(e);
    const steps = [{ set: { carry: 'clipboard' } }];
    for (const [x, y, em] of [[9, 4, '?'], [12, 4, '.'], [16, 4, '?'], [12, 8, '!']]) steps.push({ go: [x, y], face: 'up' }, { emote: em, secs: 1.4 }, { act: 'inspect', ms: 1700 });
    e.setPlan(intent, steps, true);
  } else {
    const L = LOC[name], sp = claimSpot(e, name), face = L.face || 'up';
    // aim at the furniture this station faces, even from an overflow tile beside it
    const at = [clampN(sp[0], L.minX, L.maxX), L.row];
    e.setPlan(intent, [{ set: { carry: null } }, { go: sp, face }, { act: L.act, at }]);
  }
}

function finishPlan(e, cookId) {
  release(e);
  e.task = 'Order up';
  const px = nextSlot(), food = pick(FOODS);
  const steps = [{ set: { carry: 'plate', food } }, { go: [px, CHEF_SPOT[1]], face: 'down' }, { act: 'place', ms: 450 },
    { fn: m => { if (orderCooking()) { addPlate(px, food); burst(px * T + 8, MAP.pass.y * T + 3, ['#fff3b0', '#fff'], 5); } m.cook = null; m.label = null; m.task = ''; } },
    { set: { carry: null } }, { emote: 'n', secs: 1.4 }];
  if (e.temp) steps.push({ go: DOOR }, { fn: m => { m.gone = true; } });
  else steps.push({ go: e.home, face: 'down' }, { act: 'nap', sit: STOOLS.some(([x, y]) => x === e.home[0] && y === e.home[1]) });
  e.setPlan('done:' + cookId, steps);
}

function chefPlan(s, instant) {
  const c = s.chef || { status: 'idle' }, o = s.order;
  const atPass = face => ({ go: CHEF_SPOT, face });
  chef.ti = chefTier(s); chef.effort = c.effort || '';
  if (c.status === 'waiting') {
    release(chef);
    chef.setPlan('wait', [atPass('down'), { emote: '?', secs: 60 }, { act: 'wave' }]);
    if (!customer.emote) customer.say('!', 3);
  } else if (c.status === 'working') {
    const kind = c.kind || 'think';
    if (kind === 'delegate') { release(chef); chef.setPlan('shout:' + c.activity, [atPass('up'), { emote: '!', secs: 1.4 }, { act: 'shout' }]); }
    else if (kind === 'read' || kind === 'search') workPlan(chef, 'head-chef', kind);
    else if (kind === 'web') workPlan(chef, 'head-chef', 'read');
    else if (kind === 'run') {
      if (chef.intent !== 'work:stove') { const sp = claimSpot(chef, 'stove'); chef.setPlan('work:stove', [{ go: sp, face: 'up' }, { act: 'pan', at: [clampN(sp[0], LOC.stove.minX, LOC.stove.maxX), LOC.stove.row] }]); }
    }
    else if (kind === 'think') { release(chef); chef.setPlan('think', [atPass('down'), { emote: '.', secs: 2 }, { act: 'think' }]); }
    else { release(chef); chef.setPlan('plate', [atPass('down'), { act: 'plate', at: [CHEF_SPOT[0], MAP.pass.y] }]); }
  } else if (o && o.status === 'served') {
    release(chef);
    const serve = () => { for (const p of plates) burst(p.x * T + 8, MAP.pass.y * T + 3, ['#ffe27a', '#fff'], 6); plates = []; customerPlate = true; customer.say('h', 3); };
    if (instant) { plates = []; customerPlate = true; chef.setPlan('served:' + o.startedAt, [atPass('down'), { act: 'stand' }]); }
    else chef.setPlan('served:' + o.startedAt, [atPass('down'), { act: 'ring', ms: 1500, at: [MAP.bell.x, MAP.pass.y] }, { fn: serve }, { emote: 'n', secs: 2 }, { act: 'stand' }]);
  } else {
    release(chef);
    chef.setPlan('idle', [atPass('down'), { act: 'stand' }]);
  }
}

// ---------- applying a snapshot ----------

let sessionId = null, lastOrderAt = null, lastDropN = 0, first = true;

function applyState(s) {
  s = s || {};
  try {
    if ((s.id || null) !== sessionId) {
      sessionId = s.id || null; resetWorld(); first = true; lastOrderAt = null; lastDropN = s.lastDrop ? s.lastDrop.n : 0;
      dialogReset(); details.clear(); logs.clear();
    }
    live = s; // the plate rules below read the order from it
    // On first load, and while the tab is hidden (no frames run), finishes settle at once instead of animating.
    const instant = first || document.hidden;
    const cooks = Array.isArray(s.cooks) ? s.cooks : [], o = s.order;

    if (o && o.startedAt !== lastOrderAt) {
      lastOrderAt = o.startedAt; chalk = 0;
      if (!first) { plates = []; customerPlate = false; customer.say('!', 2); }
    }
    if (first) {
      // loading mid-order: one plate on the pass for each cook of this order that has already finished
      plates = [];
      if (o && o.status === 'cooking') for (const c of cooks) if (statusOf(c) === 'done' && !(o.startedAt && c.endedAt && c.endedAt < o.startedAt)) addPlate(nextSlot(), pick(FOODS));
    }
    chefPlan(s, instant);
    chef.task = (s.chef && s.chef.activity) || '';

    for (const c of cooks) {
      if (!isBusy(c)) continue;
      let e = byCook.get(c.id);
      if (!e) {
        const r = residents.get(c.role) || residents.get('stagiaire');
        if (!r.cook) e = r;
        else { e = new Monkey(c.role, ...DOOR); e.temp = true; monkeys.push(e); }
        e.cook = c.id; byCook.set(c.id, e);
        if (!instant) e.say('!', 1.2);
      }
      e.label = cookName(c);
      e.task = c.activity || '';
      e.ti = cookTier(c); e.effort = c.effort || '';
      e.quiet = statusOf(c) === 'quiet';
      workPlan(e, c.role, c.kind || 'think');
    }
    for (const [id, e] of byCook) {
      const c = cooks.find(x => x.id === id), st = c ? statusOf(c) : null;
      if (st === 'working' || st === 'quiet') continue;
      byCook.delete(id); e.quiet = false;
      if (st === 'done' && !instant) { finishPlan(e, id); continue; }
      if (st === 'done' && orderCooking()) addPlate(nextSlot(), pick(FOODS));
      if (st === 'failed' && !instant) { e.say('!', 2); smash(e); }
      e.cook = null; e.label = null; e.task = '';
      if (instant && e.temp) { release(e); e.gone = true; }
    }
    for (const e of monkeys) {
      if (e === chef || e === customer || e.cook || e.gone || (e.intent || '').startsWith('done:')) continue;
      if (e.temp) { if (instant) { release(e); e.gone = true; } else exitPlan(e); } else idlePlan(e);
    }
    monkeys = monkeys.filter(e => { if (e.gone) release(e); return !e.gone; });

    if (s.lastDrop && s.lastDrop.n !== lastDropN) {
      lastDropN = s.lastDrop.n;
      const e = s.lastDrop.by === 'head-chef' ? chef : byCook.get(s.lastDrop.by);
      if (e && !instant) { e.say('!', 1.6); smash(e); }
    }
    renderPanels(s);
  } finally {
    first = false;
  }
}

// ---------- particles ----------

function spawn(x, y, vx, vy, life, c, g = 0, size = 1) { if (!reduced && particles.length < 400) particles.push({ x, y, vx, vy, g, life, max: life, c, size }); }
function burst(x, y, colors, n) { for (let i = 0; i < n; i++) spawn(x, y, rnd(-30, 30), rnd(-45, -10), rnd(.4, .8), pick(colors), 90); }
function smash(e) { for (let i = 0; i < 10; i++) spawn(e.x + 8, e.y + 12, rnd(-45, 45), rnd(-50, -5), rnd(.5, .9), pick(['#fff', '#dfe7ec', '#e8792e']), 200, pick([1, 2])); }

const JAR = ['#e8792e', '#6cbf4b', '#e7c94a', '#d9534f', '#7cc6ea'];
function effects(e, dt) {
  if (e.hidden || e.moving || !e.act) return;
  const cx = e.at ? e.at[0] * T + 8 : e.x + 8, cy = e.at ? e.at[1] * T + 3 : e.y;
  if ((e.et -= dt) <= 0) {
    e.et = rnd(2.6, 4);
    const em = e.quiet ? 'z' : { nap: 'z', read: '.', plan: 'b', taste: 'h', rummage: '?', think: '.', snack: 'n' }[e.act];
    if (em && !e.emote) e.say(em, 1.5);
  }
  if (e.quiet || (e.fx -= dt) > 0) return;
  switch (e.act) {
    case 'chop': e.fx = .16; spawn(cx + rnd(-3, 3), cy + 2, rnd(-28, 28), rnd(-45, -25), .5, pick(['#e8792e', '#6cbf4b', '#4f9a3c']), 170); break;
    case 'peel': e.fx = .2; spawn(cx + rnd(-3, 3), cy + 3, rnd(-24, 24), rnd(-40, -20), .5, pick(['#b08a56', '#d2b07a']), 170); break;
    case 'pan': e.fx = .2; spawn(cx + rnd(-3, 3), cy, rnd(-5, 5), rnd(-22, -14), .9, '#fff', 0, 2); break;
    case 'taste': e.fx = .35; spawn(cx + rnd(-3, 3), cy - 4, rnd(-4, 4), rnd(-16, -10), .9, '#fff', 0, 2); break;
    case 'grill': e.fx = .16; spawn(cx + rnd(-5, 5), cy + 2, rnd(-6, 6), rnd(-26, -14), .8, pick(['#9aa0a6', '#c9cdd2', '#ffb347']), 0, pick([1, 2])); break;
    case 'bake': e.fx = .5; spawn(cx + rnd(-4, 4), cy, rnd(-4, 4), rnd(-14, -8), 1, '#fff', 0, 2); break;
    case 'pipe': e.fx = .2; spawn(cx + rnd(-6, 6), cy + rnd(0, 4), rnd(-8, 8), rnd(-24, -12), .6, pick(['#f08db0', '#fff', '#ffe27a']), 0); break;
    case 'wash': e.fx = .16; spawn(cx + rnd(-5, 5), cy + 2, rnd(-8, 8), rnd(-22, -10), .9, pick(['#b7e2f6', '#fff']), 0, pick([1, 2])); break;
    case 'chalk': e.fx = .22; chalk = Math.min(1, chalk + .012); spawn(cx + rnd(-8, 8), T + 12, rnd(-4, 4), rnd(8, 16), .5, '#e8f0e4'); break;
    case 'rummage': e.fx = .22; spawn(cx + rnd(-4, 4), cy + 10, rnd(-40, 40), rnd(-50, -30), .6, pick(JAR), 190, 2); break;
    case 'whisk': e.fx = .18; spawn(cx + rnd(-4, 4), cy + 2, rnd(-10, 10), rnd(-30, -16), .6, pick(['#fff', '#ffe27a', '#fff3b0']), 20, pick([1, 2])); break;
    case 'plate': e.fx = .4; spawn(cx + rnd(-4, 4), cy, rnd(-6, 6), rnd(-18, -8), .6, pick(['#ffe27a', '#fff']), 0); break;
    case 'ring': e.fx = .08; spawn(cx + rnd(-2, 2), cy, rnd(-40, 40), rnd(-50, -15), .6, pick(['#ffe27a', '#fff', '#e7c94a']), 80); break;
    default: e.fx = .5;
  }
}

// ---------- drawing ----------

const canvas = $('game'), ctx = canvas.getContext('2d');
const bg = document.createElement('canvas');
let scale = 2, bgScale = 0, cssScale = 2, sceneW = W * 2, sceneH = H * 2, overlayFont = '', hcKey = '';

function resize() {
  const cssW = canvas.parentElement.clientWidth;
  if (!cssW) return;
  scale = Math.max(2, Math.round(cssW * (window.devicePixelRatio || 1) / W));
  if (scale !== bgScale) {
    bgScale = scale;
    canvas.width = bg.width = W * scale; canvas.height = bg.height = H * scale;
    const b = bg.getContext('2d');
    b.setTransform(scale, 0, 0, scale, 0, 0); b.imageSmoothingEnabled = false;
    drawBackground(b);
  }
  cssScale = cssW / W; sceneW = cssW; sceneH = cssW * H / W;
  const fs = Math.max(9, cssScale * 4.6) + 'px';
  if (fs !== overlayFont) { overlayFont = fs; $('overlay').style.fontSize = fs; }
  for (const t of tags.values()) t.dirty = true;
  hcKey = ''; hcSize = null;
}
let resizeQueued = false;
function requestResize() {
  if (resizeQueued) return;
  resizeQueued = true;
  requestAnimationFrame(() => { resizeQueued = false; resize(); fitAll(clamps); });
}
function watchDpr() { // fires when the window moves to a screen with another pixel ratio, or the page is zoomed
  matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`).addEventListener('change', () => { requestResize(); watchDpr(); }, { once: true });
}

const using = (act, tx) => monkeys.some(m => m.act === act && !m.moving && !m.hidden && !m.quiet && m.at && m.at[0] === tx);

let rail = { cooks: [], more: 0 };
function drawDynamic(time) {
  const flick = Math.floor(time * 10) % 2;
  // back door stands open while someone is out on a run
  if (monkeys.some(m => m.hidden || (Math.round(m.x / T) === 0 && Math.round(m.y / T) === 3))) { R(ctx, 2, T + 2, 12, 30, '#1c1622'); R(ctx, 2, T + 2, 3, 30, '#9a6a3c'); }
  if (using('rummage', MAP.fridge.x)) { const x = MAP.fridge.x * T, y = T; R(ctx, x + 1, y + 12, 14, 18, '#fff3b0'); R(ctx, x + 3, y + 15, 4, 4, '#6cbf4b'); R(ctx, x + 9, y + 16, 3, 3, '#d9534f'); R(ctx, x + 2, y + 21, 12, 1, '#c9bfa6'); R(ctx, x + 4, y + 24, 5, 4, '#7cc6ea'); }
  for (let i = 0; i < 2; i++) {
    const tx = MAP.stove.x + i, x = tx * T, y = 2 * T;
    if (using('pan', tx)) {
      const sh = flick ? 1 : 0;
      R(ctx, x + 4, y + 7, 8, 1, flick ? '#ffb347' : '#ff7a2f'); R(ctx, x + 2 + sh, y + 1, 11, 6, INK); R(ctx, x + 3 + sh, y + 2, 9, 4, '#555b68'); R(ctx, x + 4 + sh, y + 3, 7, 2, flick ? '#e8792e' : '#e7c94a'); R(ctx, x + 12 + sh, y + 3, 4, 2, INK);
    }
    const gx = MAP.grill.x + i;
    if (using('grill', gx)) { const x2 = gx * T; R(ctx, x2 + 4, y + 2, 8, 4, INK); R(ctx, x2 + 5, y + 3, 6, 2, '#8a3a2a'); R(ctx, x2 + 2 + flick * 9, y + 6, 2, 2, '#ffb347'); R(ctx, x2 + 7, y + 7, 2, 1, '#ff7a2f'); }
  }
  if (using('bake', MAP.oven.x)) R(ctx, MAP.oven.x * T + 3, 2 * T + 11, 10, 3, flick ? '#ffb347' : '#ff8a3a');
  for (let i = 0; i < 2; i++) if (using('wash', MAP.sink.x + i)) R(ctx, (MAP.sink.x + i) * T + 7, 2 * T + 2, 2, 4, '#b7e2f6');
  // the menu fills in as the scribe writes
  { const x = MAP.menu.x * T + 5, lines = Math.floor(chalk * 4); for (let i = 0; i <= lines && i < 4; i++) R(ctx, x, T + 4 + i * 2, i === lines ? Math.floor((chalk * 4 % 1) * 30) + 4 : [34, 26, 30, 20][i], 1, '#e8f0e4'); }
  // tickets on the rail: working first, then the newest finished, and "+N" when they do not all fit
  rail.cooks.forEach((c, i) => {
    const x = MAP.rail.x * T + 3 + i * 11, done = !isBusy(c), ti = cookTier(c);
    R(ctx, x, T + 4, 8, 10, INK); R(ctx, x + 1, T + 5, 6, 8, done ? '#c9bfa6' : '#fff8ea'); R(ctx, x + 1, T + 5, 6, 2, TIER_COLOR[ti && ti.tier] || TIER_COLOR.other);
    if (!done) { R(ctx, x + 2, T + 9, 4, 1, '#8a96a1'); R(ctx, x + 2, T + 11, 3, 1, '#8a96a1'); }
  });
  if (rail.more) drawTiny(ctx, MAP.rail.x * T + 3 + rail.cooks.length * 11, T + 7, '+' + Math.min(99, rail.more), INK);
  for (const p of plates) drawPlate(ctx, p.x * T + 4, MAP.pass.y * T + 2, p.food);
  if (chef.act === 'ring' && flick) { const x = MAP.bell.x * T; R(ctx, x + 4, MAP.pass.y * T + 1, 8, 5, '#fff3b0'); }
  if (customerPlate) drawPlate(ctx, MAP.table.x * T + 12, MAP.table.y * T + 3, '#e8792e');
}

function drawMonkey(e) {
  const x = Math.round(e.x), y = Math.round(e.y) - (e.sit ? 4 : 0), dozing = e.quiet && !e.moving;
  let frame = 0, bob = 0;
  if (e.moving) frame = 1 + Math.floor(e.t * 8) % 2;
  else if (e.act === 'nap' || dozing) bob = Math.floor(e.t * 1.2) % 2;
  else if (ARMS.has(e.act)) { frame = 3 + Math.floor(e.t * 6) % 2; bob = Math.floor(e.t * 6) % 2; }
  R(ctx, x + 3, Math.round(e.y) + 14, 10, 2, 'rgba(43,34,51,.22)');
  if (e.carry && e.dir === 'up') drawCarry(e, x + 4, y + 4);
  ctx.drawImage(monkeySprite(e.role, e.dir, frame, e.act === 'nap' || dozing), x - 1, y - 7 + bob);
  if (e.carry && e.dir !== 'up') drawCarry(e, e.dir === 'left' ? x - 3 : e.dir === 'right' ? x + 11 : x + 4, y + 8);
  if (e.act === 'snack') { R(ctx, x + 10, y + 7, 4, 2, '#f4d03f'); R(ctx, x + 13, y + 6, 1, 1, '#f4d03f'); }
  if (e.emote) drawEmote(ctx, x + 4, y - 17 + (Math.floor(e.t * 3) % 2), e.emote);
}
function drawCarry(e, x, y) {
  if (e.carry === 'plate') drawPlate(ctx, x, y, e.food);
  else if (e.carry === 'crate') drawCrate(ctx, x, y - 2);
  else if (e.carry === 'clipboard') drawClipboard(ctx, x + 2, y - 2);
}

// ---------- name tags ----------
// Each tag sits under its monkey's feet, centred on it and kept inside the scene. Tags are laid out
// top to bottom; one that would overlap a tag already placed is pushed down (or up, when there is no
// room below) until it is clear. Sizes are cached and re-measured only when the text or the scene size changes.

let labelsTasks = true;
try { labelsTasks = localStorage.getItem('mk-labels') !== 'names'; } catch (_) {}
const tags = new Map();
const tagTitle = e => [e.label, chipLabel(e.ti, e.effort), e.task].filter(Boolean).join(' · ');
function tagY(x, y0, w, h, placed) {
  const hit = y => placed.find(p => x < p.x + p.w && x + w > p.x && y < p.y + p.h && y + h > p.y);
  let y = y0, p;
  for (let n = 0; n < 40 && (p = hit(y)); n++) y = p.y + p.h + 1;
  if (!hit(y) && y + h <= sceneH) return y;
  y = y0;
  for (let n = 0; n < 40 && (p = hit(y)); n++) y = p.y - h - 1;
  if (!hit(y) && y >= 0) return y;
  return clampN(y0, 0, Math.max(0, sceneH - h));
}
function updateTags() {
  const list = [], s = sceneW / W;
  for (const e of monkeys) {
    const show = !e.hidden && e.label && (e !== chef || (live && live.chef && live.chef.status && live.chef.status !== 'idle'));
    if (!show) continue;
    let t = tags.get(e);
    if (!t) {
      const el = document.createElement('div');
      el.className = 'tag';
      el.innerHTML = '<div class="tag-name"></div><div class="tag-task"></div>';
      $('overlay').appendChild(el);
      t = { el, nameEl: el.firstChild, taskEl: el.lastChild, name: null, task: null, title: null, col: null, w: 0, h: 0, x: null, y: null, dirty: true, seen: false };
      tags.set(e, t);
    }
    t.seen = true;
    const task = labelsTasks && e.task ? e.task : '', title = tagTitle(e), col = TIER_COLOR[e.ti && e.ti.tier] || '#fff';
    if (t.name !== e.label) { t.name = e.label; t.nameEl.textContent = e.label; t.dirty = true; }
    if (t.task !== task) { t.task = task; t.taskEl.textContent = task; t.dirty = true; }
    if (t.title !== title) { t.title = title; t.el.title = title; }
    if (t.col !== col) { t.col = col; t.el.style.borderColor = col; }
    list.push([e, t]);
  }
  for (const [e, t] of tags) { if (!t.seen) { t.el.remove(); tags.delete(e); } else t.seen = false; }
  for (const [, t] of list) if (t.dirty) { t.w = t.el.offsetWidth; t.h = t.el.offsetHeight; t.dirty = false; } // reads only, after all the writes above
  list.sort((a, b) => a[0].y - b[0].y);
  const placed = [];
  for (const [e, t] of list) {
    const x = clampN((e.x + 8) * s - t.w / 2, 1, Math.max(1, sceneW - t.w - 1));
    const y = tagY(x, (e.y + 17) * s, t.w, t.h, placed);
    placed.push({ x, y, w: t.w, h: t.h });
    const rx = Math.round(x), ry = Math.round(y);
    if (rx !== t.x || ry !== t.y) { t.x = rx; t.y = ry; t.el.style.transform = `translate(${rx}px, ${ry}px)`; }
  }
}

// ---------- animation loop ----------

let lastT = performance.now(), lastDraw = 0, live = null;
function frame(now) {
  requestAnimationFrame(frame);
  if (now - lastDraw < FRAME_MS) return;
  lastDraw = now;
  const dt = Math.min(.1, (now - lastT) / 1000); lastT = now;
  for (const e of monkeys) { e.update(dt); effects(e, dt); }
  monkeys = monkeys.filter(e => { if (e.gone) release(e); return !e.gone; });
  for (const p of particles) { p.life -= dt; p.vy += p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt; }
  particles = particles.filter(p => p.life > 0);

  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bg, 0, 0);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  drawDynamic(now / 1000);
  for (const e of [...monkeys].sort((a, b) => a.y - b.y)) if (!e.hidden) drawMonkey(e);
  for (const p of particles) { ctx.globalAlpha = Math.min(1, p.life / p.max * 2); R(ctx, Math.round(p.x), Math.round(p.y), p.size, p.size, p.c); }
  ctx.globalAlpha = 1;
  updateTags();
  updateHover();
  dialogTick(dt);
}

// No frames run while the tab is hidden. Going hidden, and coming back, everyone finishes what they were
// doing at once (a plate being carried lands, a monkey walking home arrives) instead of rushing about later.
document.addEventListener('visibilitychange', () => {
  for (const e of monkeys) fastForward(e);
  for (const e of monkeys) if (e.temp && !e.cook) e.gone = true;
  monkeys = monkeys.filter(e => { if (e.gone) release(e); return !e.gone; });
  particles = []; lastT = performance.now();
});

// ---------- text box, side panels ----------

const dialogEl = $('dialog-text');
const dialog = { queue: [], text: '', shown: 0, hold: 0, lastKey: null };
const dialogClamp = makeClamp(dialogEl, 3, 'dialog');
function dialogReset() { dialog.queue = []; dialog.text = ''; dialog.shown = 0; dialog.hold = 0; dialog.lastKey = null; clampOpen.delete(dialogClamp.key); dialogClamp.set(''); }
function dialogPush(text) { dialog.queue.push(text); if (dialog.queue.length > 3) dialog.queue.splice(0, dialog.queue.length - 3); }
function dialogShow(text) { // each message starts collapsed and empty, then types out
  dialog.text = text; dialog.shown = 0; dialog.hold = 1.3;
  clampOpen.delete(dialogClamp.key); dialogClamp.key = 'dialog:' + text;
  dialogClamp.set('');
}
function dialogTick(dt) {
  if (dialog.shown < dialog.text.length) {
    dialog.shown = reduced ? dialog.text.length : Math.min(dialog.text.length, dialog.shown + dt * 60);
    if (dialog.shown < dialog.text.length) dialogEl.textContent = dialog.text.slice(0, Math.floor(dialog.shown));
    else if (dialogClamp.text === dialog.text) { dialogEl.textContent = dialog.text; dialogClamp.fit(); } // measured once, when typing is done
    else dialogClamp.set(dialog.text);
  } else if ((dialog.hold -= dt) <= 0 && dialog.queue.length) dialogShow(dialog.queue.shift());
}

const fmt = n => { n = Number(n) || 0; return n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n); };
const money = n => { n = Number(n) || 0; return '$' + (n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toFixed(3)); };

function setText(el, v) { v = v == null ? '' : String(v); if (el.textContent === v) return false; el.textContent = v; return true; }
function setHTML(el, v) { if (el._html === v) return; el._html = v; el.innerHTML = v; }
const cookName = c => c.role === 'stagiaire' && c.agentType ? c.agentType : (ROLE[c.role] || ROLE.stagiaire).name;
const clockTime = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const stepsText = (n, more) => n == null ? '' : `${n}${more ? '+' : ''} step${n === 1 && !more ? '' : 's'}`;
const logKey = l => l.t + '|' + l.text;
const feedKey = f => f.t + '|' + f.who + '|' + f.text;

// Who said a feed line. Guest agents go by their agent type when the line (or the rail) says which one.
function whoName(f, cooks) {
  if (f.who !== 'stagiaire' && ROLE[f.who]) return ROLE[f.who].name;
  if (f.agentType) return f.agentType;
  const id = f.cook || f.agentId, c = id && cooks.find(x => x.id === id);
  if (c) return cookName(c);
  const types = new Set(cooks.filter(x => x.role === 'stagiaire' && x.agentType).map(x => x.agentType));
  if (types.size === 1) return [...types][0];
  return types.size ? 'Guest' : ROLE.stagiaire.name;
}

// ---------- full ticket text: fetched on demand from the v2 server, cached per cook ----------

const details = new Map(); // cook id, or 'chef' -> { sig, data, state: 'loading' | 'ok' | 'error', next }
const sq = () => 'session=' + encodeURIComponent(sessionId || '');
function wantDetail(key, sig, url) {
  let d = details.get(key);
  if (d && d.sig === sig) return d;
  if (d && d.state === 'loading') { d.sig = sig; d.next = url; return d; } // fetch again once this one lands
  d = { sig, data: d ? d.data : null, state: 'loading', next: null };
  details.set(key, d);
  loadDetail(key, d, url);
  return d;
}
function loadDetail(key, d, url) {
  fetch(url, { cache: 'no-store' })
    .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(j => {
      if (details.get(key) !== d) return;
      d.data = j && typeof j === 'object' ? j : {}; d.state = 'ok';
      const r = logs.get(key); // the full log fills in whatever the live frames never carried
      if (r && Array.isArray(d.data.log)) { r.log = unionLog(d.data.log, r.log); r.partial = false; }
    })
    .catch(() => { if (details.get(key) === d) d.state = 'error'; })
    .finally(() => {
      if (details.get(key) !== d) return; // session changed or cook left meanwhile
      if (d.next) { const u = d.next; d.next = null; d.state = 'loading'; loadDetail(key, d, u); return; }
      if (live) batchClamps(() => renderLine(live));
    });
}

// ---------- step logs: kept per cook (and for the chef) from every frame, open card or not ----------
// A v2 frame carries only each cook's last 8 steps, so the page keeps its own log of the last LOG_CAP.
// When a frame's oldest step is newer than everything kept (frames were missed), that is a gap: `gaps`
// goes up, which changes the card's fetch signature, so an open card fetches the full log again.
const LOG_CAP = 20;
const logs = new Map(); // cook id, or 'chef' -> { log, gaps, partial, order }
function unionLog(a, b) {
  const seen = new Set(), out = [];
  for (const l of a.concat(b)) { const k = logKey(l); if (!seen.has(k)) { seen.add(k); out.push(l); } }
  out.sort((x, y) => (x.t || 0) - (y.t || 0));
  return out.slice(-LOG_CAP);
}
function trackLog(key, recent, windowed) {
  recent = Array.isArray(recent) ? recent : [];
  let r = logs.get(key);
  if (!r) {
    // a v2 window that is already full may be missing older steps
    r = { log: unionLog(recent, []), gaps: 0, partial: windowed && recent.length >= 8, order: null };
    logs.set(key, r);
    return r;
  }
  if (!recent.length) return r;
  const keys = new Set(r.log.map(logKey)), lastT = r.log.length ? r.log[r.log.length - 1].t || 0 : -Infinity;
  if (r.log.length && (recent[0].t || 0) > lastT && !keys.has(logKey(recent[0]))) { r.gaps++; r.partial = true; }
  if (recent.some(l => !keys.has(logKey(l)))) r.log = unionLog(r.log, recent);
  return r;
}

// ---------- "On the line" panel: entries keyed by cook id, patched in place ----------

let clockSkew = 0, frozenNow = null;
const lineEnts = new Map(), lineOpen = new Set();
const nowMs = () => frozenNow != null ? frozenNow : Date.now() + clockSkew; // timers stop while disconnected
function mmss(ms) {
  const t = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), sec = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

let entSeq = 0;
function makeEnt(id) {
  const el = document.createElement('div'), bodyId = 'ent-body-' + (++entSeq);
  el.className = 'ent';
  el.innerHTML = `<button type="button" class="ent-main" aria-expanded="false" aria-controls="${bodyId}">` +
    '<span class="ent-head"><i class="ent-dot"></i><b class="ent-name"></b><span class="chip"></span><span class="ent-st"></span><span class="ent-el"></span><span class="ent-n"></span><span class="ent-caret" aria-hidden="true">▸</span></span></button>' +
    '<div class="ent-sub"><div class="ent-ticket"></div><div class="ent-act"></div></div>' +
    `<div class="ent-body" id="${bodyId}" hidden>` +
    '<p class="ent-msg" hidden></p>' +
    '<div class="sec sec-prompt"><h3>Ticket</h3><pre class="ent-prompt"></pre></div>' +
    '<div class="sec sec-log"><h3>Recent steps</h3><ol class="ent-log"></ol></div>' +
    '<div class="sec sec-report"><h3>Report</h3><pre class="ent-report"></pre></div></div>';
  const q = c => el.querySelector('.' + c);
  const ent = { id, el, main: q('ent-main'), sub: q('ent-sub'), dot: q('ent-dot'), name: q('ent-name'), chip: q('chip'), st: q('ent-st'), elapsed: q('ent-el'), n: q('ent-n'),
    ticket: q('ent-ticket'), act: q('ent-act'), body: q('ent-body'), msg: q('ent-msg'), prompt: q('ent-prompt'), log: q('ent-log'), report: q('ent-report'),
    secPrompt: q('sec-prompt'), secLog: q('sec-log'), secReport: q('sec-report'), logSig: null, logInit: false, d: null, col: null };
  ent.cTicket = makeClamp(ent.ticket, 3, id + ':ticket');
  ent.cPrompt = makeClamp(ent.prompt, 6, id + ':prompt');
  ent.cReport = makeClamp(ent.report, 6, id + ':report');
  const toggle = () => {
    if (lineOpen.has(id)) lineOpen.delete(id);
    else { lineOpen.add(id); const det = details.get(id); if (det && det.state === 'error') details.delete(id); }
    batchClamps(() => paintEnt(ent));
  };
  ent.main.addEventListener('click', toggle);
  // The ticket text opens the card too (mouse only; the header button is the keyboard control). A mouse up
  // that ends a text selection inside this card is not a click. The header has no such guard: browsers keep
  // a selection when a button is clicked, so the guard would make headers dead while any text is selected.
  ent.sub.addEventListener('click', ev => {
    if (ev.target.closest('button')) return;
    const sel = getSelection();
    if (sel && String(sel).length && sel.anchorNode && el.contains(sel.anchorNode)) return;
    toggle();
  });
  return ent;
}
function dropEnt(ent) {
  ent.el.remove();
  for (const c of [ent.cTicket, ent.cPrompt, ent.cReport]) dropClamp(c);
  if (ent.log._rows) for (const r of ent.log._rows.values()) dropClamp(r.clamp);
}

function makeStep(l, key) {
  const li = document.createElement('li');
  li.innerHTML = '<time></time><div class="step-main"><div class="step-text"></div></div>';
  li.firstChild.textContent = clockTime(l.t);
  const text = li.querySelector('.step-text');
  text.textContent = l.text; // registered by makeClamp and measured with the rest of the list
  return { el: li, clamp: makeClamp(text, 2, key) };
}

function paintEnt(ent) {
  const d = ent.d, open = lineOpen.has(ent.id), cls = 'ent ' + d.state + (open ? ' open' : '');
  if (ent.el.className !== cls) ent.el.className = cls;
  ent.main.setAttribute('aria-expanded', open);
  ent.body.hidden = !open;
  if (!open) { ent.logInit = false; return; }
  let prompt = d.prompt, report = d.report, log = d.log || [], msg = '';
  if (d.fetch) {
    const det = wantDetail(ent.id, d.sig, d.fetch);
    if (det.data) { prompt = det.data.prompt || ''; report = det.data.report || ''; } // the log itself is kept by trackLog
    if (det.state === 'error') msg = det.data ? 'Could not refresh the full ticket from the server; showing what loaded earlier.' : 'Could not load the full ticket from the server.';
    else if (!det.data) msg = 'Loading…';
  }
  setText(ent.msg, msg); ent.msg.hidden = !msg;
  ent.secPrompt.hidden = !prompt; ent.secReport.hidden = !report;
  ent.cPrompt.set(prompt); ent.cReport.set(report);
  const sig = JSON.stringify(log);
  ent.secLog.hidden = !log.length;
  if (sig !== ent.logSig) {
    const ol = ent.log, stick = !ent.logInit || ol.scrollHeight - ol.scrollTop - ol.clientHeight < 6;
    patchList(ol, log, logKey, (l, k) => makeStep(l, ent.id + ':step:' + k));
    ent.logSig = sig;
    if (stick) afterFit(() => { ol.scrollTop = ol.scrollHeight; }); // once the new rows have been measured
  } else if (!ent.logInit) afterFit(() => { ent.log.scrollTop = ent.log.scrollHeight; });
  for (const c of [ent.cPrompt, ent.cReport]) if (c.dirty) fitLater(c); // sections that were hidden when their text arrived
  fitDirty(ent.log);
  ent.logInit = true;
}

function tickEnts() {
  for (const ent of lineEnts.values()) {
    const d = ent.d;
    if (d && d.start) setText(ent.elapsed, mmss((d.end || nowMs()) - d.start)); else if (d) setText(ent.elapsed, '');
  }
}
setInterval(tickEnts, 1000);

function renderLine(s) {
  const want = [], c = s.chef, o = s.order, v2 = feedV === 2;
  // the chef's log starts over with each order
  const orderAt = (o && o.startedAt) || 0, prevChef = logs.get('chef');
  if (prevChef && prevChef.order !== orderAt) { logs.delete('chef'); details.delete('chef'); }
  const chefLog = trackLog('chef', s.chefLog, v2); chefLog.order = orderAt;
  if (c && c.status && c.status !== 'idle') {
    const n = chefLog.log.length;
    want.push({ id: 'chef', name: 'Head Chef', ti: chefTier(s), effort: c.effort || '', state: c.status === 'waiting' ? 'waiting' : 'working', status: c.status,
      ticket: '', act: c.activity || 'Thinking', log: chefLog.log, prompt: '', report: '',
      fetch: v2 && sessionId ? '/chef?' + sq() : null, sig: orderAt + '|' + chefLog.gaps,
      start: o && o.status === 'cooking' ? orderAt : 0, end: 0, steps: stepsText(n, chefLog.partial || n >= LOG_CAP) });
  }
  const cooks = Array.isArray(s.cooks) ? s.cooks : [];
  const present = new Set(cooks.map(x => x.id));
  for (const k of [...logs.keys()]) if (k !== 'chef' && !present.has(k)) logs.delete(k);
  for (const x of cooks) trackLog(x.id, x.log, v2);
  const fin = x => x.endedAt || x.startedAt || 0;
  const working = cooks.filter(isBusy).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  const done = cooks.filter(x => !isBusy(x)).sort((a, b) => fin(b) - fin(a));
  for (const x of [...working, ...done].slice(0, 40)) {
    const st = statusOf(x), busy = st === 'working' || st === 'quiet', old = typeof x.prompt === 'string', tl = logs.get(x.id);
    want.push({
      id: x.id, name: cookName(x), ti: cookTier(x), effort: x.effort || '', state: st, status: st,
      ticket: x.ticket || '', act: busy ? (x.activity || 'Getting started') : endText(st),
      log: tl.log, prompt: old ? x.prompt : '', report: old ? x.report || '' : '',
      fetch: old || !sessionId ? null : `/cook?${sq()}&id=${encodeURIComponent(x.id)}`, sig: `${x.promptLen}|${x.promptRev}|${x.reportLen}|${busy ? 0 : 1}|${tl.gaps}`, // promptRev: a corrected ticket of the same length
      start: x.startedAt || 0, end: busy ? 0 : (x.endedAt || (st === 'lost' ? x.lastEventAt || x.startedAt || 0 : 0)), steps: stepsText(x.tools),
    });
  }
  for (const k of [...details.keys()]) if (k !== 'chef' && !present.has(k)) details.delete(k);
  if (!want.some(w => w.id === 'chef')) details.delete('chef');
  $('line-empty').hidden = want.length > 0;
  const box = $('line'), ids = new Set(want.map(w => w.id));
  for (const [id, ent] of lineEnts) if (!ids.has(id)) { dropEnt(ent); lineEnts.delete(id); lineOpen.delete(id); }
  for (const w of want) {
    let ent = lineEnts.get(w.id);
    if (!ent) { ent = makeEnt(w.id); lineEnts.set(w.id, ent); }
    ent.d = w;
  }
  placeInOrder(box, want.map(w => lineEnts.get(w.id).el));
  for (const w of want) {
    const ent = lineEnts.get(w.id), col = TIER_COLOR[w.ti && w.ti.tier] || TIER_COLOR.other;
    if (ent.col !== col) { ent.col = col; ent.dot.style.background = col; ent.chip.style.background = col; }
    setText(ent.name, w.name);
    ent.chip.hidden = !(w.ti || w.effort); setText(ent.chip, chipLabel(w.ti, w.effort));
    setText(ent.st, w.status);
    setText(ent.n, w.steps);
    ent.cTicket.set(w.ticket); setText(ent.act, w.act);
    paintEnt(ent);
  }
  tickEnts();
}

// ---------- order box, label toggle ----------

const orderClamp = makeClamp($('order-text'), 3, 'order');
function paintLabelsBtn() { $('labels-toggle').textContent = labelsTasks ? 'Labels: names + tasks' : 'Labels: names'; $('labels-toggle').setAttribute('aria-pressed', labelsTasks); }
$('labels-toggle').addEventListener('click', () => {
  labelsTasks = !labelsTasks;
  try { localStorage.setItem('mk-labels', labelsTasks ? 'tasks' : 'names'); } catch (_) {}
  paintLabelsBtn();
});
paintLabelsBtn();

// ---------- page title, scene description ----------

const BASE_TITLE = document.title;
// "Needs you" when the shown session's Head Chef is waiting, or any listed session's is (named, if it is not the shown one).
function titleFor(list, s) {
  if (s && s.chef && s.chef.status === 'waiting') return '🛎️ Needs you · Monkey Kitchen';
  const others = list.filter(x => x.chefStatus === 'waiting' && (!s || x.id !== s.id));
  if (!others.length) return BASE_TITLE;
  return `🛎️ Needs you in ${others.length === 1 ? others[0].project || 'another session' : others.length + ' sessions'} · Monkey Kitchen`;
}
function setTitle(t) { if (document.title !== t) document.title = t; }

let ariaText = '', ariaAt = 0, ariaTimer = 0;
function describeScene(s) {
  const ch = s.chef || {}, cooks = Array.isArray(s.cooks) ? s.cooks : [], parts = [];
  if (ch.status === 'waiting') parts.push('The Head Chef is waiting on you');
  else if (ch.status === 'working') parts.push('The Head Chef is working: ' + (ch.activity || 'thinking'));
  else parts.push('The Head Chef is at the pass');
  const busy = cooks.filter(isBusy), done = cooks.filter(c => statusOf(c) === 'done').length;
  if (busy.length) parts.push(`${busy.length} on the line: ` + busy.slice(0, 6).map(c => cookName(c) + (statusOf(c) === 'quiet' ? ' (quiet)' : '') + (c.activity ? ', ' + c.activity : '')).join('; ') + (busy.length > 6 ? `; and ${busy.length - 6} more` : ''));
  else parts.push('Nobody is on the line');
  if (done) parts.push(`${done} finished`);
  return 'Kitchen scene. ' + parts.join('. ') + '.';
}
function updateAria(text) { // at most every few seconds, so a screen reader is not flooded
  ariaText = text;
  if (ariaTimer) return;
  ariaTimer = setTimeout(() => { ariaTimer = 0; ariaAt = Date.now(); if (canvas.getAttribute('aria-label') !== ariaText) canvas.setAttribute('aria-label', ariaText); },
    Math.max(0, 3000 - (Date.now() - ariaAt)));
}

const renderPanels = s => batchClamps(() => paintPanels(s)); // every clamp that changed is measured once, at the end

function paintPanels(s) {
  live = s;
  const o = s.order || {}, cooks = Array.isArray(s.cooks) ? s.cooks : [];
  const cls = 'order ' + (o.status || '');
  if ($('order').className !== cls) $('order').className = cls;
  const okey = 'order:' + (o.startedAt || '');
  if (orderClamp.key !== okey) { clampOpen.delete(orderClamp.key); orderClamp.key = okey; fitLater(orderClamp); } // a new order starts collapsed
  orderClamp.set(o.text || 'No order yet. Send one from Claude Code.');
  setText($('dropped'), s.dropped || 0);

  // text box: narrate new feed lines
  const feed = Array.isArray(s.feed) ? s.feed : [];
  if (!feed.length) { if (!dialog.text) dialogShow('The kitchen is quiet. Everyone is on break.'); }
  else {
    const from = dialog.lastKey === null ? -1 : feed.findLastIndex(f => feedKey(f) === dialog.lastKey);
    const fresh = dialog.lastKey === null ? feed.slice(-1) : feed.slice(from + 1);
    for (const f of fresh) dialogPush(`${whoName(f, cooks).toUpperCase()} ${f.text}`);
    dialog.lastKey = feedKey(feed[feed.length - 1]);
  }

  // tickets on the rail
  const busy = cooks.filter(isBusy).sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  const fin = cooks.filter(c => !isBusy(c)).sort((a, b) => (b.endedAt || b.startedAt || 0) - (a.endedAt || a.startedAt || 0));
  const all = busy.concat(fin), fit = all.length > 11 ? 10 : 11;
  rail = { cooks: all.slice(0, fit), more: Math.max(0, all.length - fit) };

  renderLine(s);

  // tab
  const u = s.usage, tiers = u && Array.isArray(u.tiers) ? u.tiers : [];
  if (tiers.length) {
    const tot = u.total || {};
    setHTML($('usage-body'), tiers.map(t => `
      <tr><td><i style="background:${TIER_COLOR[t.tier] || TIER_COLOR.other}"></i>${esc(TIER_LABEL[t.tier] || t.tier)}</td>
      <td>${fmt(t.input)}</td><td>${fmt(t.output)}</td><td>${fmt(t.cacheRead)}</td><td>${money(t.cost)}</td></tr>`).join('') +
      `<tr class="total"><td>Total</td><td>${fmt(tot.input)}</td><td>${fmt(tot.output)}</td><td>${fmt(tot.cacheRead)}</td><td>${money(tot.cost)}</td></tr>`);
    const solo = Number(u.soloCost) || 0, saved = solo - (Number(tot.cost) || 0);
    setHTML($('saving'), solo > 0 && saved > 0.0005
      ? `Head Chef alone: <b>${money(solo)}</b>. Brigade saved <b>${Math.round(100 * saved / solo)}%</b>.`
      : (solo > 0 ? 'No savings yet: everything ran at the Head Chef’s tier.' : ''));
  } else {
    setHTML($('usage-body'), '<tr><td colspan="5" class="muted">Nothing cooked yet</td></tr>');
    setHTML($('saving'), '');
  }

  patchList($('feed'), feed.slice().reverse(), feedKey, (f, k) => {
    const li = document.createElement('li');
    li.className = f.fail ? 'fail' : '';
    li.innerHTML = `<time>${esc(clockTime(f.t))}</time><div class="feed-text"><div><b>${esc(whoName(f, cooks))}</b> ${esc(f.text)}</div></div>`;
    return { el: li, clamp: makeClamp(li.lastChild, 2, 'feed:' + k) }; // dirty until patchList measures all new rows together
  });
  if (clamps.size > 300) pruneClamps();
  updateAria(describeScene(s));
}

// ---------- hover card ----------

const JOB = {
  'head-chef': 'Runs the pass: splits the order into tickets, hands them out, checks every plate.',
  'sous-chef': 'Plans big changes, makes design calls, finds the root cause of bugs.',
  'chef-de-partie': 'Takes the hard build tickets in any layer.',
  inspector: 'Reviews finished changes for bugs and security problems.',
  'frontend-cook': 'Front-end work: components, pages, styling.',
  'backend-cook': 'Back-end work: APIs, data, jobs.',
  'line-cook': 'Other build work: scripts, config, tooling.',
  taster: 'Runs the tests and checks, reports pass or fail with evidence.',
  'prep-cook': 'Finds and reads code, returns quoted evidence.',
  runner: 'Looks things up on the web and in docs.',
  scribe: 'Writes docs for code that already exists.',
  dishwasher: 'Mechanical cleanup: formatting, lint fixes, listed renames.',
  stagiaire: 'A guest agent from outside the brigade.',
};
const hc = { el: $('hovercard'), ent: null, col: null };
hc.el.innerHTML = '<div class="hc-head"><b class="hc-name"></b><span class="chip hc-chip"></span><span class="hc-model"></span></div>' +
  '<div class="hc-status"></div><div class="hc-ticket"></div><div class="hc-act"></div><div class="hc-job"></div><ol class="hc-log"><li></li><li></li><li></li></ol>';
{
  const q = c => hc.el.querySelector('.' + c);
  Object.assign(hc, { name: q('hc-name'), chip: q('hc-chip'), model: q('hc-model'), status: q('hc-status'), ticket: q('hc-ticket'), act: q('hc-act'), job: q('hc-job'), logEl: q('hc-log') });
}

function hoverInfo(e) {
  const o = live && live.order, ch = (live && live.chef) || { status: 'idle' };
  if (e === customer) {
    const text = (o && o.text) || '';
    return { name: 'You', status: !o ? 'No order yet' : o.status === 'served' ? 'Served' : o.status === 'stopped' ? 'Stopped' : 'Waiting on the order', ticket: text.length > 200 ? text.slice(0, 200).trimEnd() + '…' : text };
  }
  if (e === chef) {
    return { name: 'Head Chef', ti: chefTier(live), effort: ch.effort || '', model: (live && live.usage && live.usage.mainModel) || '',
      status: ch.status === 'waiting' ? 'Waiting on you' : ch.status === 'working' ? 'Working' : 'Idle',
      act: ch.status === 'idle' ? '' : (ch.activity || ''), job: ch.status === 'idle' ? JOB['head-chef'] : '', log: ((live && live.chefLog) || []).slice(-3) };
  }
  const c = e.cook && live && (live.cooks || []).find(x => x.id === e.cook);
  if (c) {
    const st = statusOf(c), busy = st === 'working' || st === 'quiet', bits = [st];
    if (c.startedAt) bits.push(mmss((busy ? nowMs() : (c.endedAt || (st === 'lost' && c.lastEventAt) || nowMs())) - c.startedAt));
    if (c.tools != null) bits.push(stepsText(c.tools));
    return { name: cookName(c), ti: cookTier(c), effort: c.effort || '', model: c.model || '', status: bits.join(' · '), ticket: c.ticket || '',
      act: busy ? (c.activity || 'Getting started') : endText(st), log: (c.log || []).slice(-3) };
  }
  const r = ROLE[e.role] || ROLE.stagiaire;
  return { name: r.name, ti: guessTier(e.role), status: 'On break', job: JOB[e.role] || '' };
}

function paintHover(e) { // returns whether anything changed, so the card is only re-placed when it has to be
  const d = hoverInfo(e), col = TIER_COLOR[d.ti && d.ti.tier] || TIER_COLOR.other;
  let ch = setText(hc.name, d.name);
  const noChip = !(d.ti || d.effort);
  if (hc.chip.hidden !== noChip) { hc.chip.hidden = noChip; ch = true; }
  ch = setText(hc.chip, chipLabel(d.ti, d.effort)) || ch;
  if (hc.col !== col) { hc.col = col; hc.chip.style.background = col; }
  ch = setText(hc.model, d.model) || ch; ch = setText(hc.status, d.status) || ch; ch = setText(hc.ticket, d.ticket) || ch;
  ch = setText(hc.act, d.act) || ch; ch = setText(hc.job, d.job) || ch;
  hc.logEl.querySelectorAll('li').forEach((li, i) => { const l = d.log && d.log[i]; if (li.hidden !== !l) { li.hidden = !l; ch = true; } ch = setText(li, l ? l.text : '') || ch; });
  return ch;
}

// The card's size is read only when its content changed (or the scene was resized); following a walking
// monkey reuses the cached size, so moving the card never forces a layout.
let hcSize = null;
function placeHover(e, measure) {
  if (measure || !hcSize) hcSize = { w: hc.el.offsetWidth, h: hc.el.offsetHeight };
  const sw = sceneW, sh = sceneH, s = sw / W, w = hcSize.w, h = hcSize.h, gap = 6;
  let x = (e.x + 17) * s + gap, y = (e.y - 8) * s - h - gap; // above and to the right of the sprite
  if (x + w > sw) x = (e.x - 1) * s - w - gap;               // no room on the right: flip to the left
  if (y < 0) y = (e.y + 16) * s + gap;                        // no room above: drop below the feet
  hc.el.style.left = Math.round(Math.max(0, Math.min(x, sw - w))) + 'px';
  hc.el.style.top = Math.round(Math.max(0, Math.min(y, sh - h))) + 'px';
}

function setHover(e) {
  if (e === hc.ent) return;
  hc.ent = e; hc.el.hidden = !e; hcKey = '';
  canvas.style.cursor = e ? 'pointer' : '';
  if (e) { paintHover(e); placeHover(e, true); hcKey = Math.round(e.x) + ',' + Math.round(e.y) + ',' + sceneW; }
}
function updateHover() { // every frame while shown: follow the monkey, patch the text, re-place only when needed
  const e = hc.ent;
  if (!e) return;
  if (e.hidden || !monkeys.includes(e)) { setHover(null); return; }
  const changed = paintHover(e), key = Math.round(e.x) + ',' + Math.round(e.y) + ',' + sceneW;
  if (changed || key !== hcKey) { hcKey = key; placeHover(e, changed); }
}

function monkeyAt(ev) {
  const r = canvas.getBoundingClientRect(), wx = (ev.clientX - r.left) / r.width * W, wy = (ev.clientY - r.top) / r.height * H;
  let best = null;
  for (const e of monkeys) {
    if (e.hidden || wx < e.x - 1 || wx > e.x + 17 || wy < e.y - 8 || wy > e.y + 16) continue;
    if (!best || e.y > best.y) best = e; // the lower one is drawn in front
  }
  return best;
}

function openLineCard(e) {
  const id = e === chef ? 'chef' : e.cook, ent = id && lineEnts.get(id);
  if (!ent || !ent.d) return;
  lineOpen.add(id);
  const det = details.get(id); if (det && det.state === 'error') details.delete(id);
  batchClamps(() => paintEnt(ent));
  ent.el.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
}

let ptype = 'mouse';
canvas.addEventListener('pointerdown', ev => { ptype = ev.pointerType; });
canvas.addEventListener('pointermove', ev => { if (ev.pointerType === 'touch') return; ptype = ev.pointerType; setHover(monkeyAt(ev)); });
canvas.addEventListener('pointerleave', ev => { if (ev.pointerType !== 'touch') setHover(null); });
canvas.addEventListener('click', ev => {
  const e = monkeyAt(ev);
  if (ptype === 'touch') { if (e && e === hc.ent) openLineCard(e); else setHover(e); return; } // first tap shows the card, a second tap opens the ticket
  if (e) openLineCard(e);
});
document.addEventListener('pointerdown', ev => { if (ev.pointerType === 'touch' && ev.target !== canvas) setHover(null); });

// ---------- session picker + live connection ----------
// Two feed shapes are understood. v1 (old server): { now, sessions: [full session objects] }.
// v2: { v: 2, now, sessions: [summaries], session: <the watched session or null> }, where /events?session=<id>
// picks the session and no id follows the most recently active one.

let watching = null, feedV = 0, lastAll = null, es = null, connId = null, retryTimer = 0, pickSig = '';
let connected = null, lastMsgAt = 0; // null: not known yet, so the first answer either way is painted

// The frame lists only the most recent sessions, so the session being watched is kept as an option even
// when it drops off that list. Options are sorted by name, not recency, and while the picker has focus
// (its list may be open) a rebuild waits until it loses focus.
const pickNames = new Map(); // session id -> project, for every session seen
let pickPending = null;
function buildPicker(opts) {
  const sel = $('session-pick');
  sel.innerHTML = '<option value="">Latest session</option>' + opts.map(x =>
    `<option value="${esc(x.id)}">${esc(x.project)} · ${esc(String(x.id).slice(0, 6))}</option>`).join('');
  sel.value = watching || '';
  pickPending = null;
}
function updatePicker(list) {
  const sel = $('session-pick');
  for (const x of list) pickNames.set(x.id, x.project);
  const opts = list.map(x => ({ id: x.id, project: x.project }));
  if (watching && !opts.some(x => x.id === watching)) opts.push({ id: watching, project: pickNames.get(watching) || 'session' });
  opts.sort((a, b) => String(a.project).localeCompare(String(b.project)) || String(a.id).localeCompare(String(b.id)));
  const sig = opts.map(x => x.id + '|' + x.project).join('\n');
  if (sig !== pickSig) {
    pickSig = sig;
    if (document.activeElement === sel) pickPending = opts; else buildPicker(opts);
  }
  $('session-wrap').hidden = opts.length < 2;
}
$('session-pick').addEventListener('blur', () => { if (pickPending) buildPicker(pickPending); });

// "Latest session" stays on the session it shows while that one is still in the list, unless it has been
// still for QUIET_SWITCH_MS and another one has been active since. When the shown session is no longer
// listed: following (no id on the connection), take the server's pick; pinned to an id, take the newest listed.
function pickLatest(list, now, serverPick, pinned) {
  if (!list.length) return serverPick || null;
  const newest = list.reduce((a, b) => (b.lastEventAt || 0) > (a.lastEventAt || 0) ? b : a);
  const shown = sessionId && list.find(x => x.id === sessionId);
  if (!shown) return pinned ? newest.id : serverPick || newest.id;
  const still = now - (shown.lastEventAt || 0) >= QUIET_SWITCH_MS;
  return newest.id !== shown.id && still && (newest.lastEventAt || 0) > (shown.lastEventAt || 0) ? newest.id : shown.id;
}

// v1 sessions carry no lastEventAt: the newest timestamp anywhere in them stands in for it.
function activityAt(s) {
  let t = (s.order && s.order.startedAt) || 0;
  const last = a => Array.isArray(a) && a.length ? a[a.length - 1].t || 0 : 0;
  t = Math.max(t, last(s.feed), last(s.chefLog));
  for (const c of s.cooks || []) t = Math.max(t, c.lastEventAt || 0, c.endedAt || 0);
  return t;
}

function route(f) {
  const list = Array.isArray(f.sessions) ? f.sessions : [];
  if (feedV === 2) {
    const got = f.session && f.session.id ? f.session : null;
    // a watched session that drops off the (top-N) list is still watched; only "no such session" ends it
    if (watching && !got && connId === watching) { watching = null; $('session-pick').value = ''; }
    updatePicker(list);
    const target = watching || pickLatest(list, nowMs(), got && got.id, connId !== null);
    if (target && (!got || got.id !== target) && connId !== target) { connect(target); return; }
    if (!target && connId) { connect(null); return; }
    applyState(got);
    setTitle(titleFor(list, got));
  } else {
    // the old server sends whole sessions, so one that is not listed cannot be shown
    const sums = list.map(x => ({ id: x.id, project: x.project, lastEventAt: activityAt(x), chefStatus: x.chef && x.chef.status }));
    if (watching && !sums.some(x => x.id === watching)) { watching = null; $('session-pick').value = ''; }
    updatePicker(sums);
    const target = watching || pickLatest(sums, nowMs(), list[0] && list[0].id, false);
    const s = list.find(x => x.id === target) || null;
    applyState(s);
    setTitle(titleFor(sums, s));
  }
}

function onFrame(f) {
  if (!f || typeof f !== 'object') return;
  if (typeof f.now === 'number') clockSkew = f.now - Date.now(); // only a fresh message moves the clock
  lastMsgAt = Date.now(); frozenNow = null; setConn(true);
  feedV = f.v === 2 ? 2 : 1;
  lastAll = f;
  route(f);
}

function setConn(on) {
  if (on === connected) return;
  const was = connected;
  connected = on;
  const conn = $('conn');
  conn.classList.toggle('live', on);
  conn.title = on ? 'Connected to the kitchen server' : 'Disconnected from the kitchen server';
  conn.setAttribute('aria-label', on ? 'Connected' : 'Disconnected');
  $('scene').classList.toggle('dim', !on);
  // #offline stays in the page as a live region (never `hidden`), so a change of its text is announced;
  // the `on` class is what shows it
  const off = $('offline');
  off.classList.toggle('on', !on);
  off.textContent = on ? (was === false ? 'Reconnected' : '') : `Disconnected · last update ${lastMsgAt ? clockTime(lastMsgAt) : 'none yet'}`;
  if (!on) frozenNow = nowMs();
}

function connect(id) {
  clearTimeout(retryTimer);
  if (es) { es.onopen = es.onmessage = es.onerror = null; es.close(); }
  connId = id || null;
  const src = new EventSource('/events' + (connId ? '?session=' + encodeURIComponent(connId) : ''));
  es = src;
  src.onopen = () => { setLocked(false); setConn(true); };
  src.onmessage = ev => {
    let f;
    try { f = JSON.parse(ev.data); } catch (err) { console.warn('Monkey Kitchen: unreadable snapshot', err); return; }
    try { onFrame(f); } catch (err) { console.error('Monkey Kitchen: could not show a snapshot', err); }
  };
  src.onerror = () => {
    // an HTTP error closes an EventSource for good; anything else it retries by itself
    if (src.readyState !== EventSource.CLOSED) { setConn(false); return; }
    // Closed by an HTTP error: a kitchen without our key (401) is locked, not down.
    const retry = () => checkAuth().then(state => {
      if (es !== src) return;
      if (state === 'locked') { setLocked(true); retryTimer = setTimeout(retry, 5000); return; } // ask again, quietly
      const wasLocked = locked;
      setLocked(false);
      if (state === 'ok' && wasLocked) { connect(connId); return; } // unlocked meanwhile (the link opened in another tab)
      setConn(false);
      retryTimer = setTimeout(() => { if (es === src) connect(connId); }, 3000);
    });
    retry();
  };
}

// 'ok', 'locked' (401 from /auth) or 'unknown' (no answer: the server is down or restarting).
function checkAuth() {
  return fetch('/auth', { cache: 'no-store', credentials: 'same-origin' })
    .then(r => (r.status === 401 ? 'locked' : r.ok ? 'ok' : 'unknown'))
    .catch(() => 'unknown');
}

// Locked: the scene stays dimmed with an explanation in place of the "Disconnected" banner. While locked the page
// keeps asking, so opening the link in this browser (another tab) brings it in without a reload.
let locked = false;
function setLocked(on) {
  if (on === locked) return;
  locked = on;
  const off = $('offline'), conn = $('conn');
  off.classList.toggle('locked', on);
  if (on) {
    setConn(false); // dims the scene, stops the clocks and shows the banner, whose text is replaced here
    conn.title = 'This kitchen is locked';
    conn.setAttribute('aria-label', 'Locked');
    off.textContent = 'This kitchen is locked. Open the link Claude Code gives you: run /monkey-kitchen:kitchen in your session.';
    canvas.setAttribute('aria-label', 'Kitchen scene. This kitchen is locked.');
  } else if (connected === false) {
    // Back to plain "disconnected" until a frame arrives.
    conn.title = 'Disconnected from the kitchen server';
    conn.setAttribute('aria-label', 'Disconnected');
    off.textContent = `Disconnected · last update ${lastMsgAt ? clockTime(lastMsgAt) : 'none yet'}`;
  }
}

resetWorld();
resize();
window.addEventListener('resize', requestResize);
if (window.ResizeObserver) new ResizeObserver(requestResize).observe($('scene'));
watchDpr();
$('session-pick').addEventListener('change', e => {
  watching = e.target.value || null;
  if (!lastAll) return;
  if (feedV === 2) { const target = watching || pickLatest(lastAll.sessions || [], nowMs(), sessionId, connId !== null); if (target !== connId) connect(target); }
  else { try { route(lastAll); } catch (err) { console.error('Monkey Kitchen: could not switch sessions', err); } } // re-shown from the last message; the clock offset stays as it was
});
requestAnimationFrame(frame);
connect(null);
