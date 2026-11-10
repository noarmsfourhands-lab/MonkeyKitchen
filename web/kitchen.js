// Monkey Kitchen front end. A small top-down simulation: every agent is a
// monkey that walks to the part of the kitchen matching what it is doing.
// State arrives as snapshots over /events; art.js does the drawing.

const ROLES = [
  { id: 'head-chef', name: 'Head Chef', tier: 'fable' },
  { id: 'sous-chef', name: 'Sous Chef', tier: 'opus' },
  { id: 'chef-de-partie', name: 'Senior Cook', tier: 'opus' },
  { id: 'frontend-cook', name: 'Pastry Chef', tier: 'opus' },
  { id: 'backend-cook', name: 'Grill Cook', tier: 'opus' },
  { id: 'line-cook', name: 'Line Cook', tier: 'opus' },
  { id: 'taster', name: 'Taster', tier: 'opus' },
  { id: 'inspector', name: 'Inspector', tier: 'opus' },
  { id: 'prep-cook', name: 'Prep Cook', tier: 'opus' },
  { id: 'runner', name: 'Runner', tier: 'opus' },
  { id: 'dishwasher', name: 'Dishwasher', tier: 'opus' },
  { id: 'scribe', name: 'Menu Scribe', tier: 'opus' },
  { id: 'stagiaire', name: 'Stagiaire', tier: 'guest' },
];
const ROLE = Object.fromEntries(ROLES.map(r => [r.id, r]));
const TIER_LABEL = { fable: 'Fable', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', guest: 'Guest', other: 'Other' };
const TIER_COLOR = { fable: '#b77fd0', opus: '#f08a63', sonnet: '#5cc7c7', haiku: '#8fd17c', guest: '#b8b8b8', other: '#b8b8b8' };

// Where each kind of work happens. `spots` are the tiles a monkey stands on.
const LOC = {
  shelf: { act: 'read', spots: [[4, 3], [5, 3], [4, 4], [5, 4]] },
  pantry: { act: 'rummage', spots: [[2, 3], [3, 3], [1, 3], [2, 4], [3, 4]] },
  sink: { act: 'wash', spots: [[7, 3], [8, 3], [7, 4], [8, 4]] },
  board: { act: 'chop', spots: [[9, 3], [10, 3], [9, 4], [10, 4]] },
  stove: { act: 'pan', spots: [[11, 3], [12, 3], [11, 4], [12, 4]] },
  oven: { act: 'bake', spots: [[13, 3], [13, 4]] },
  grill: { act: 'grill', spots: [[14, 3], [15, 3], [14, 4], [15, 4]] },
  pastry: { act: 'pipe', spots: [[16, 3], [17, 3], [16, 4], [17, 4]] },
  menu: { act: 'chalk', spots: [[21, 2], [20, 2], [22, 2]] },
  desk: { act: 'plan', spots: [[1, 8], [2, 8]] },
  pot: { act: 'taste', spots: [[9, 5], [10, 5]], face: 'down' },
  bowl: { act: 'whisk', spots: [[12, 5], [13, 5], [14, 5]], face: 'down' },
  spuds: { act: 'peel', spots: [[15, 7], [14, 7], [16, 7]] },
};
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
const ARMS = new Set(['chop', 'pan', 'grill', 'pipe', 'wash', 'chalk', 'peel', 'rummage', 'place', 'ring', 'wave', 'plate', 'shout', 'bake', 'taste', 'whisk']);
const SPEED = 62; // world pixels per second

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

// ---------- show more / show less ----------
// makeClamp(el, lines, key) turns a text element into one that is cut to `lines` lines, with a real
// button after it that appears only when the text actually overflows. The open/closed state lives in
// clampOpen under `key`, so it survives re-renders; c.set(text) changes the text, c.fit() re-measures.
const clampOpen = new Set(), clamps = new Set();
function makeClamp(el, lines, key) {
  el.classList.add('clamp-text'); el.style.setProperty('--lines', lines);
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'clamp-btn'; btn.hidden = true;
  el.after(btn);
  const c = {
    el, btn, key, text: null, over: false, dirty: true,
    set(v) {
      v = v == null ? '' : String(v);
      if (v === c.text) return;
      c.text = v; el.textContent = v;
      if (!v) { c.over = false; c.dirty = false; el.classList.remove('expanded'); btn.hidden = true; return; }
      c.fit();
    },
    fit() {
      if (!el.clientWidth) { c.dirty = true; return; } // hidden right now: fitted again when it shows
      c.dirty = false;
      const open = clampOpen.has(c.key), top = el.scrollTop;
      el.classList.remove('expanded');
      c.over = el.scrollHeight > el.clientHeight + 1;
      const exp = c.over && open;
      el.classList.toggle('expanded', exp);
      if (exp) el.scrollTop = top;
      btn.hidden = !c.over;
      btn.textContent = exp ? 'Show less' : 'Show more';
      btn.setAttribute('aria-expanded', exp);
    },
  };
  btn.addEventListener('click', ev => { ev.stopPropagation(); if (clampOpen.has(c.key)) clampOpen.delete(c.key); else clampOpen.add(c.key); c.fit(); });
  btn.addEventListener('keydown', ev => ev.stopPropagation()); // Enter/Space on the button must not toggle the card around it
  clamps.add(c);
  return c;
}
function pruneClamps() { for (const c of clamps) if (!c.el.isConnected) clamps.delete(c); }
window.addEventListener('resize', () => { pruneClamps(); for (const c of clamps) if (c.text) c.fit(); });

// Keeps a list of keyed rows patched in place (no rebuild, so scroll positions and open states survive).
// make(item, key) returns { el, clamp? }; rows are moved only when out of place.
function patchList(box, items, keyOf, make) {
  const m = box._rows || (box._rows = new Map()), seen = new Set();
  let ref = box.firstElementChild;
  for (const it of items) {
    let k = keyOf(it);
    for (let n = 1; seen.has(k); n++) k = keyOf(it) + '#' + n;
    seen.add(k);
    let rec = m.get(k);
    if (!rec) { rec = make(it, k); m.set(k, rec); }
    if (rec.el === ref) ref = ref.nextElementSibling; else box.insertBefore(rec.el, ref);
  }
  for (const [k, rec] of m) if (!seen.has(k)) { rec.el.remove(); m.delete(k); if (rec.clamp) { clamps.delete(rec.clamp); clampOpen.delete(rec.clamp.key); } }
  fitDirty(box);
}
function fitDirty(box) { if (box._rows) for (const r of box._rows.values()) if (r.clamp && r.clamp.dirty) r.clamp.fit(); }

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
        if (!this.path) this.path = findPath(Math.round(this.x / T), Math.round(this.y / T), s.go[0], s.go[1]);
        if (!this.path.length) { this.x = s.go[0] * T; this.y = s.go[1] * T; if (s.face) this.dir = s.face; this.path = null; this.i++; continue; }
        const [nx, ny] = this.path[0], dx = nx * T - this.x, dy = ny * T - this.y, dist = Math.hypot(dx, dy), step = SPEED * dt;
        if (Math.abs(dx) > Math.abs(dy)) this.dir = dx < 0 ? 'left' : 'right'; else if (dy) this.dir = dy < 0 ? 'up' : 'down';
        if (dist <= step) { this.x = nx * T; this.y = ny * T; this.path.shift(); } else { this.x += dx / dist * step; this.y += dy / dist * step; }
        this.act = null; this.moving = true;
        return;
      }
      if (s.act) {
        this.act = s.act; this.at = s.at || null; if (s.sit) this.sit = true;
        if (!s.ms) return;
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

function release(e) { if (e.claim && claims.get(e.claim) === e) claims.delete(e.claim); e.claim = null; }
function claimSpot(e, name) {
  release(e);
  for (const sp of LOC[name].spots) { const k = sp.join(); if (!claims.has(k)) { claims.set(k, e); e.claim = k; return sp; } }
  const L = LOC[name]; // every spot taken: spread the overflow instead of stacking on one tile
  L.over = ((L.over || 0) + 1) % L.spots.length;
  return L.spots[L.over];
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
    release(e);
    const sp = LOC.pantry.spots[2];
    e.setPlan(intent, [{ set: { carry: null } }, { go: DOOR, face: 'up' }, { hide: 1300 }, { set: { carry: 'crate' } }, { go: sp, face: 'up' },
      { act: 'rummage', ms: 900, at: [sp[0], 2] }, { set: { carry: null } }], true);
  } else if (name === 'patrol') {
    release(e);
    const steps = [{ set: { carry: 'clipboard' } }];
    for (const [x, y, em] of [[9, 4, '?'], [12, 4, '.'], [16, 4, '?'], [12, 8, '!']]) steps.push({ go: [x, y], face: 'up' }, { emote: em, secs: 1.4 }, { act: 'inspect', ms: 1700 });
    e.setPlan(intent, steps, true);
  } else {
    const L = LOC[name], sp = claimSpot(e, name), face = L.face || 'up';
    // facing up at a back-wall station the furniture is on row 2, whichever row we stand on (the menu board is on the wall, row 1)
    const at = face === 'up' ? [sp[0], name === 'menu' ? sp[1] - 1 : 2] : [sp[0], sp[1] + 1];
    e.setPlan(intent, [{ set: { carry: null } }, { go: sp, face }, { act: L.act, at }]);
  }
}

function finishPlan(e, cookId) {
  release(e);
  const px = PLATE_SLOTS[plateSlot++ % PLATE_SLOTS.length];
  const food = pick(['#e8792e', '#6cbf4b', '#f2a7c0', '#e7c94a', '#b5522c']);
  const steps = [{ set: { carry: 'plate', food } }, { go: [px, CHEF_SPOT[1]], face: 'down' }, { act: 'place', ms: 450 },
    { fn: m => { plates.push({ x: px, food }); m.cook = null; m.label = null; burst(px * T + 8, MAP.pass.y * T + 3, ['#fff3b0', '#fff'], 5); } },
    { set: { carry: null } }, { emote: 'n', secs: 1.4 }];
  if (e.temp) steps.push({ go: DOOR }, { fn: m => { m.gone = true; } });
  else steps.push({ go: e.home, face: 'down' }, { act: 'nap', sit: STOOLS.some(([x, y]) => x === e.home[0] && y === e.home[1]) });
  e.setPlan('done:' + cookId, steps);
}

function chefPlan(s, first) {
  const c = s.chef || { status: 'idle' }, o = s.order;
  const atPass = face => ({ go: CHEF_SPOT, face });
  chef.tier = 'fable';
  if (c.status === 'waiting') {
    release(chef);
    chef.setPlan('wait', [atPass('down'), { emote: '?', secs: 60 }, { act: 'wave' }]);
    if (!customer.emote) customer.say('!', 3);
  } else if (c.status === 'working') {
    const kind = c.kind || 'think';
    if (kind === 'delegate') { release(chef); chef.setPlan('shout:' + c.activity, [atPass('up'), { emote: '!', secs: 1.4 }, { act: 'shout' }]); }
    else if (kind === 'read' || kind === 'search') workPlan(chef, 'head-chef', kind);
    else if (kind === 'web') workPlan(chef, 'head-chef', 'read');
    else if (kind === 'run') { const sp = claimSpot(chef, 'stove'); chef.setPlan('work:stove', [{ go: sp, face: 'up' }, { act: 'pan', at: [sp[0], 2] }]); }
    else if (kind === 'think') { release(chef); chef.setPlan('think', [atPass('down'), { emote: '.', secs: 2 }, { act: 'think' }]); }
    else { release(chef); chef.setPlan('plate', [atPass('down'), { act: 'plate', at: [CHEF_SPOT[0], MAP.pass.y] }]); }
  } else if (o && o.status === 'served') {
    release(chef);
    const serve = () => { for (const p of plates) burst(p.x * T + 8, MAP.pass.y * T + 3, ['#ffe27a', '#fff'], 6); plates = []; customerPlate = true; customer.say('h', 3); };
    if (first) { customerPlate = true; chef.setPlan('served:' + o.startedAt, [atPass('down'), { act: 'stand' }]); }
    else chef.setPlan('served:' + o.startedAt, [atPass('down'), { act: 'ring', ms: 1500, at: [MAP.bell.x, MAP.pass.y] }, { fn: serve }, { emote: 'n', secs: 2 }, { act: 'stand' }]);
  } else {
    release(chef);
    chef.setPlan('idle', [atPass('down'), { act: 'stand' }]);
  }
}

// ---------- applying a snapshot ----------

let sessionId = null, lastOrderAt = null, lastDropN = 0, first = true;

function applyState(s) {
  if ((s.id || null) !== sessionId) { sessionId = s.id || null; resetWorld(); first = true; lastOrderAt = null; lastDropN = s.lastDrop ? s.lastDrop.n : 0; dialogReset(); }
  const cooks = s.cooks || [], o = s.order;

  if (o && o.startedAt !== lastOrderAt) {
    lastOrderAt = o.startedAt;
    if (!first) { plates = []; customerPlate = false; customer.say('!', 2); }
  }
  chefPlan(s, first);
  chef.task = (s.chef && s.chef.activity) || '';

  for (const c of cooks) {
    if (c.status !== 'working') continue;
    let e = byCook.get(c.id);
    if (!e) {
      const r = residents.get(c.role) || residents.get('stagiaire');
      if (!r.cook) e = r;
      else { e = new Monkey(c.role, ...DOOR); e.temp = true; monkeys.push(e); }
      e.cook = c.id; byCook.set(c.id, e);
      if (!first) e.say('!', 1.2);
    }
    e.label = cookName(c);
    e.task = c.activity || '';
    e.tier = c.tier || (ROLE[c.role] || ROLE.stagiaire).tier;
    workPlan(e, c.role, c.kind || 'think');
  }
  for (const [id, e] of byCook) {
    const c = cooks.find(x => x.id === id);
    if (c && c.status === 'working') continue;
    byCook.delete(id);
    if (c && c.status === 'done' && !first) finishPlan(e, id);
    else { if (c && c.status === 'failed') { e.say('!', 2); smash(e); } e.cook = null; e.label = null; }
  }
  for (const e of monkeys) {
    if (e === chef || e === customer || e.cook || (e.intent || '').startsWith('done:')) continue;
    if (e.temp) exitPlan(e); else idlePlan(e);
  }

  if (s.lastDrop && s.lastDrop.n !== lastDropN) {
    lastDropN = s.lastDrop.n;
    const e = s.lastDrop.by === 'head-chef' ? chef : byCook.get(s.lastDrop.by);
    if (e && !first) { e.say('!', 1.6); smash(e); }
  }
  renderPanels(s);
  first = false;
}

// ---------- particles ----------

function spawn(x, y, vx, vy, life, c, g = 0, size = 1) { if (particles.length < 400) particles.push({ x, y, vx, vy, g, life, max: life, c, size }); }
function burst(x, y, colors, n) { for (let i = 0; i < n; i++) spawn(x, y, rnd(-30, 30), rnd(-45, -10), rnd(.4, .8), pick(colors), 90); }
function smash(e) { for (let i = 0; i < 10; i++) spawn(e.x + 8, e.y + 12, rnd(-45, 45), rnd(-50, -5), rnd(.5, .9), pick(['#fff', '#dfe7ec', '#e8792e']), 200, pick([1, 2])); }

const JAR = ['#e8792e', '#6cbf4b', '#e7c94a', '#d9534f', '#7cc6ea'];
function effects(e, dt) {
  if (e.hidden || e.moving || !e.act) return;
  const cx = e.at ? e.at[0] * T + 8 : e.x + 8, cy = e.at ? e.at[1] * T + 3 : e.y;
  if ((e.et -= dt) <= 0) {
    e.et = rnd(2.6, 4);
    const em = { nap: 'z', read: '.', plan: 'b', taste: 'h', rummage: '?', think: '.', snack: 'n' }[e.act];
    if (em && !e.emote) e.say(em, 1.5);
  }
  if ((e.fx -= dt) > 0) return;
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
let scale = 2, cssScale = 2;

function resize() {
  const cssW = canvas.parentElement.clientWidth;
  scale = Math.max(2, Math.round(cssW * (window.devicePixelRatio || 1) / W));
  canvas.width = bg.width = W * scale; canvas.height = bg.height = H * scale;
  cssScale = cssW / W;
  const b = bg.getContext('2d');
  b.setTransform(scale, 0, 0, scale, 0, 0); b.imageSmoothingEnabled = false;
  drawBackground(b);
  $('overlay').style.fontSize = Math.max(9, cssScale * 4.6) + 'px';
}

const using = (act, tx) => monkeys.some(m => m.act === act && !m.moving && !m.hidden && m.at && m.at[0] === tx);

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
  // tickets on the rail
  const cooks = (live && live.cooks) || [];
  cooks.slice(0, 11).forEach((c, i) => {
    const x = MAP.rail.x * T + 3 + i * 11, done = c.status !== 'working';
    R(ctx, x, T + 4, 8, 10, INK); R(ctx, x + 1, T + 5, 6, 8, done ? '#c9bfa6' : '#fff8ea'); R(ctx, x + 1, T + 5, 6, 2, TIER_COLOR[c.tier || (ROLE[c.role] || ROLE.stagiaire).tier]);
    if (!done) { R(ctx, x + 2, T + 9, 4, 1, '#8a96a1'); R(ctx, x + 2, T + 11, 3, 1, '#8a96a1'); }
  });
  for (const p of plates) drawPlate(ctx, p.x * T + 4, MAP.pass.y * T + 2, p.food);
  if (chef.act === 'ring' && flick) { const x = MAP.bell.x * T; R(ctx, x + 4, MAP.pass.y * T + 1, 8, 5, '#fff3b0'); }
  if (customerPlate) drawPlate(ctx, MAP.table.x * T + 12, MAP.table.y * T + 3, '#e8792e');
}

function drawMonkey(e) {
  const x = Math.round(e.x), y = Math.round(e.y) - (e.sit ? 4 : 0);
  let frame = 0, bob = 0;
  if (e.moving) frame = 1 + Math.floor(e.t * 8) % 2;
  else if (ARMS.has(e.act)) { frame = 3 + Math.floor(e.t * 6) % 2; bob = Math.floor(e.t * 6) % 2; }
  else if (e.act === 'nap') bob = Math.floor(e.t * 1.2) % 2;
  R(ctx, x + 3, Math.round(e.y) + 14, 10, 2, 'rgba(43,34,51,.22)');
  if (e.carry && e.dir === 'up') drawCarry(e, x + 4, y + 4);
  ctx.drawImage(monkeySprite(e.role, e.dir, frame, e.act === 'nap'), x - 1, y - 7 + bob);
  if (e.carry && e.dir !== 'up') drawCarry(e, e.dir === 'left' ? x - 3 : e.dir === 'right' ? x + 11 : x + 4, y + 8);
  if (e.act === 'snack') { R(ctx, x + 10, y + 7, 4, 2, '#f4d03f'); R(ctx, x + 13, y + 6, 1, 1, '#f4d03f'); }
  if (e.emote) drawEmote(ctx, x + 4, y - 17 + (Math.floor(e.t * 3) % 2), e.emote);
}
function drawCarry(e, x, y) {
  if (e.carry === 'plate') drawPlate(ctx, x, y, e.food);
  else if (e.carry === 'crate') drawCrate(ctx, x, y - 2);
  else if (e.carry === 'clipboard') drawClipboard(ctx, x + 2, y - 2);
}

let labelsTasks = true;
try { labelsTasks = localStorage.getItem('mk-labels') !== 'names'; } catch (_) {}
const tags = new Map();
function updateTags() {
  const seen = new Set();
  for (const e of monkeys) {
    const show = !e.hidden && e.label && (e !== chef || (live && live.chef && live.chef.status !== 'idle'));
    if (!show) continue;
    seen.add(e);
    let el = tags.get(e);
    if (!el) { el = document.createElement('div'); el.className = 'tag'; $('overlay').appendChild(el); tags.set(e, el); }
    if (!el.firstChild) { el.innerHTML = '<div class="tag-name"></div><div class="tag-task"></div>'; }
    setText(el.firstChild, e.label);
    setText(el.lastChild, labelsTasks && e.task ? e.task : '');
    el.style.borderColor = TIER_COLOR[e.tier] || '#fff';
    el.style.left = ((e.x + 8) / W * 100) + '%';
    el.style.top = ((e.y + 17) / H * 100) + '%';
  }
  for (const [e, el] of tags) if (!seen.has(e)) { el.remove(); tags.delete(e); }
}

let lastT = performance.now(), live = null;
function frame(now) {
  const dt = Math.min(.05, (now - lastT) / 1000); lastT = now;
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
  requestAnimationFrame(frame);
}

// ---------- text box, side panels ----------

const dialog = { queue: [], text: '', shown: 0, hold: 0, lastKey: null };
const dialogClamp = makeClamp($('dialog-text'), 3, 'dialog');
function dialogReset() { dialog.queue = []; dialog.text = ''; dialog.shown = 0; dialog.hold = 0; dialog.lastKey = null; clampOpen.delete(dialogClamp.key); dialogClamp.set(''); }
function dialogPush(text) { dialog.queue.push(text); if (dialog.queue.length > 3) dialog.queue.splice(0, dialog.queue.length - 3); }
function dialogTick(dt) {
  if (dialog.shown < dialog.text.length) {
    dialog.shown = Math.min(dialog.text.length, dialog.shown + dt * 60);
    dialogClamp.set(dialog.text.slice(0, Math.floor(dialog.shown)));
  } else if ((dialog.hold -= dt) <= 0 && dialog.queue.length) {
    dialog.text = dialog.queue.shift(); dialog.shown = 0; dialog.hold = 1.3;
    clampOpen.delete(dialogClamp.key); dialogClamp.key = 'dialog:' + dialog.text; // each message starts collapsed
  }
}

const fmt = n => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n || 0);
const money = n => '$' + (n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toFixed(3));

function setText(el, v) { v = v == null ? '' : String(v); if (el.textContent !== v) el.textContent = v; }
const cookName = c => c.role === 'stagiaire' && c.agentType ? c.agentType : (ROLE[c.role] || ROLE.stagiaire).name;
const clockTime = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

// ---------- "On the line" panel: entries keyed by cook id, patched in place ----------

let clockSkew = 0;
const lineEnts = new Map(), lineOpen = new Set();
const nowMs = () => Date.now() + clockSkew;
function mmss(ms) {
  const t = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), sec = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

function makeEnt(id) {
  const el = document.createElement('div');
  el.className = 'ent';
  el.innerHTML = '<div class="ent-main" role="button" tabindex="0" aria-expanded="false">' +
    '<div class="ent-head"><i class="ent-dot"></i><b class="ent-name"></b><span class="chip"></span><span class="ent-st"></span><span class="ent-el"></span><span class="ent-n"></span><span class="ent-caret">▸</span></div>' +
    '<div class="ent-ticket"></div><div class="ent-act"></div></div>' +
    '<div class="ent-body" hidden>' +
    '<div class="sec sec-prompt"><h3>Ticket</h3><pre class="ent-prompt"></pre></div>' +
    '<div class="sec sec-log"><h3>Recent steps</h3><ol class="ent-log"></ol></div>' +
    '<div class="sec sec-report"><h3>Report</h3><pre class="ent-report"></pre></div></div>';
  const q = c => el.querySelector('.' + c);
  const ent = { id, el, main: q('ent-main'), dot: q('ent-dot'), name: q('ent-name'), chip: q('chip'), st: q('ent-st'), elapsed: q('ent-el'), n: q('ent-n'),
    ticket: q('ent-ticket'), act: q('ent-act'), body: q('ent-body'), prompt: q('ent-prompt'), log: q('ent-log'), report: q('ent-report'),
    secPrompt: q('sec-prompt'), secLog: q('sec-log'), secReport: q('sec-report'), logSig: null, logInit: false, d: null };
  ent.cTicket = makeClamp(ent.ticket, 3, id + ':ticket');
  ent.cPrompt = makeClamp(ent.prompt, 6, id + ':prompt');
  ent.cReport = makeClamp(ent.report, 6, id + ':report');
  const toggle = () => {
    if (String(getSelection()).length) return; // finishing a text selection is not a click
    if (lineOpen.has(id)) lineOpen.delete(id); else lineOpen.add(id);
    paintEnt(ent);
  };
  ent.main.addEventListener('click', toggle);
  ent.main.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
  return ent;
}

function makeStep(l, key) {
  const li = document.createElement('li');
  li.innerHTML = '<time></time><div class="step-main"><div class="step-text"></div></div>';
  li.firstChild.textContent = clockTime(l.t);
  const clamp = makeClamp(li.querySelector('.step-text'), 2, key);
  clamp.set(l.text);
  return { el: li, clamp };
}

function paintEnt(ent) {
  const d = ent.d, open = lineOpen.has(ent.id);
  ent.el.className = 'ent ' + d.state + (open ? ' open' : '');
  ent.main.setAttribute('aria-expanded', open);
  ent.body.hidden = !open;
  if (!open) { ent.logInit = false; return; }
  ent.secPrompt.hidden = !d.prompt; ent.secReport.hidden = !d.report;
  ent.cPrompt.set(d.prompt); ent.cReport.set(d.report);
  const log = d.log || [], sig = JSON.stringify(log);
  ent.secLog.hidden = !log.length;
  if (sig !== ent.logSig) {
    const ol = ent.log, stick = !ent.logInit || ol.scrollHeight - ol.scrollTop - ol.clientHeight < 6;
    patchList(ol, log, l => l.t + '|' + l.text, (l, k) => makeStep(l, ent.id + ':step:' + k));
    ent.logSig = sig;
    if (stick) ol.scrollTop = ol.scrollHeight;
  } else if (!ent.logInit) ent.log.scrollTop = ent.log.scrollHeight;
  for (const c of [ent.cPrompt, ent.cReport]) if (c.dirty) c.fit(); // sections that were hidden when their text arrived
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
  const want = [];
  const c = s.chef;
  if (c && c.status && c.status !== 'idle') {
    want.push({ id: 'chef', name: 'Head Chef', tier: 'fable', state: 'working', status: c.status, ticket: '', act: c.activity || 'Thinking', log: s.chefLog || [], prompt: '', report: '', start: 0, end: 0, steps: null });
  }
  const cooks = (s.cooks || []).slice();
  const fin = x => x.endedAt || x.startedAt || 0;
  const working = cooks.filter(x => x.status === 'working').sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  const done = cooks.filter(x => x.status !== 'working').sort((a, b) => fin(b) - fin(a));
  for (const x of [...working, ...done].slice(0, 40)) {
    const r = ROLE[x.role] || ROLE.stagiaire, st = x.status === 'working' ? 'working' : x.status === 'failed' ? 'failed' : 'done';
    want.push({
      id: x.id, name: cookName(x), tier: x.tier || r.tier, state: st, status: st,
      ticket: x.ticket || '', act: st === 'working' ? (x.activity || 'Getting started') : st === 'failed' ? 'Sent back' : 'Plated',
      log: x.log || [], prompt: x.prompt || '', report: x.report || '', start: x.startedAt || 0, end: st === 'working' ? 0 : (x.endedAt || 0), steps: x.tools,
    });
  }
  $('line-empty').hidden = want.length > 0;
  const box = $('line'), ids = new Set(want.map(w => w.id));
  for (const [id, ent] of lineEnts) if (!ids.has(id)) { ent.el.remove(); lineEnts.delete(id); lineOpen.delete(id); }
  let ref = box.firstElementChild;
  for (const w of want) {
    let ent = lineEnts.get(w.id);
    if (!ent) { ent = makeEnt(w.id); lineEnts.set(w.id, ent); }
    ent.d = w;
    if (ent.el === ref) ref = ref.nextElementSibling; else box.insertBefore(ent.el, ref); // moves only what is out of place, so scroll positions survive
    const col = TIER_COLOR[w.tier] || TIER_COLOR.other;
    ent.dot.style.background = col;
    setText(ent.name, w.name);
    setText(ent.chip, TIER_LABEL[w.tier] || w.tier); ent.chip.style.background = col;
    setText(ent.st, w.status);
    setText(ent.n, w.steps == null ? '' : `${w.steps} step${w.steps === 1 ? '' : 's'}`);
    ent.cTicket.set(w.ticket); setText(ent.act, w.act);
    paintEnt(ent);
  }
  tickEnts();
}

// ---------- order box, label toggle ----------

let orderOpen = false;
function fitOrder() {
  const box = $('order'), t = $('order-text');
  box.classList.remove('open');
  const long = t.scrollHeight > t.clientHeight + 1;
  box.classList.toggle('long', long);
  box.classList.toggle('open', long && orderOpen);
  $('order-more').textContent = long ? (orderOpen ? '▴ less' : '▾ more') : '';
}
$('order').addEventListener('click', () => { if (String(getSelection()).length) return; orderOpen = !orderOpen; fitOrder(); });
window.addEventListener('resize', fitOrder);
function paintLabelsBtn() { $('labels-toggle').textContent = labelsTasks ? 'Labels: names + tasks' : 'Labels: names'; $('labels-toggle').setAttribute('aria-pressed', labelsTasks); }
$('labels-toggle').addEventListener('click', () => {
  labelsTasks = !labelsTasks;
  try { localStorage.setItem('mk-labels', labelsTasks ? 'tasks' : 'names'); } catch (_) {}
  paintLabelsBtn();
});
paintLabelsBtn();

function renderPanels(s) {
  live = s;
  if (typeof s.now === 'number') clockSkew = s.now - Date.now();
  const o = s.order || {};
  $('order').className = 'order ' + (o.status || '');
  $('order-text').textContent = o.text || 'No order yet. Send one from Claude Code.';
  $('dropped').textContent = s.dropped || 0;

  // text box: narrate new feed lines
  const feed = s.feed || [];
  if (!feed.length) { if (!dialog.text) { dialog.text = 'The kitchen is quiet. Everyone is on break.'; dialog.shown = 0; } }
  else {
    const keyOf = f => f.t + f.text;
    let from = feed.findIndex(f => keyOf(f) === dialog.lastKey);
    const fresh = dialog.lastKey === null ? feed.slice(-1) : feed.slice(from + 1);
    for (const f of fresh) dialogPush(`${((ROLE[f.who] || ROLE.stagiaire).name).toUpperCase()} ${f.text}`);
    dialog.lastKey = keyOf(feed[feed.length - 1]);
  }

  renderLine(s);
  fitOrder();

  // tab
  const u = s.usage;
  if (u && u.tiers && u.tiers.length) {
    $('usage-body').innerHTML = u.tiers.map(t => `
      <tr><td><i style="background:${TIER_COLOR[t.tier] || TIER_COLOR.other}"></i>${TIER_LABEL[t.tier] || esc(t.tier)}</td>
      <td>${fmt(t.input)}</td><td>${fmt(t.output)}</td><td>${fmt(t.cacheRead)}</td><td>${money(t.cost)}</td></tr>`).join('') +
      `<tr class="total"><td>Total</td><td>${fmt(u.total.input)}</td><td>${fmt(u.total.output)}</td><td>${fmt(u.total.cacheRead)}</td><td>${money(u.total.cost)}</td></tr>`;
    const saved = u.soloCost - u.total.cost;
    $('saving').innerHTML = u.soloCost > 0 && saved > 0.0005
      ? `Head Chef alone: <b>${money(u.soloCost)}</b>. Brigade saved <b>${Math.round(100 * saved / u.soloCost)}%</b>.`
      : (u.soloCost > 0 ? 'No savings yet: everything ran at the Head Chef’s tier.' : '');
  } else {
    $('usage-body').innerHTML = '<tr><td colspan="5" class="muted">Nothing cooked yet</td></tr>';
    $('saving').textContent = '';
  }

  patchList($('feed'), feed.slice().reverse(), f => f.t + '|' + f.text, (f, k) => {
    const li = document.createElement('li');
    li.className = f.fail ? 'fail' : '';
    li.innerHTML = `<time>${esc(clockTime(f.t))}</time><div class="feed-text"><div><b>${esc((ROLE[f.who] || ROLE.stagiaire).name)}</b> ${esc(f.text)}</div></div>`;
    const clamp = makeClamp(li.lastChild, 2, 'feed:' + k);
    clamp.fit();
    return { el: li, clamp };
  });
  if (clamps.size > 300) pruneClamps();
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
const hc = { el: $('hovercard'), ent: null };
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
    return { name: 'You', status: !o ? 'No order yet' : o.status === 'served' ? 'Served' : 'Waiting on the order', ticket: text.length > 200 ? text.slice(0, 200).trimEnd() + '…' : text };
  }
  if (e === chef) {
    return { name: 'Head Chef', tier: 'fable', status: ch.status === 'waiting' ? 'Waiting on you' : ch.status === 'working' ? 'Working' : 'Idle',
      act: ch.status === 'idle' ? '' : (ch.activity || ''), job: ch.status === 'idle' ? JOB['head-chef'] : '', log: ((live && live.chefLog) || []).slice(-3) };
  }
  const c = e.cook && live && (live.cooks || []).find(x => x.id === e.cook);
  if (c) {
    const r = ROLE[c.role] || ROLE.stagiaire, bits = [c.status];
    if (c.startedAt) bits.push(mmss((c.status === 'working' ? nowMs() : (c.endedAt || nowMs())) - c.startedAt));
    if (c.tools != null) bits.push(`${c.tools} step${c.tools === 1 ? '' : 's'}`);
    return { name: cookName(c), tier: c.tier || r.tier, model: c.model || '', status: bits.join(' · '), ticket: c.ticket || '',
      act: c.status === 'working' ? (c.activity || 'Getting started') : c.status === 'failed' ? 'Sent back' : 'Plated', log: (c.log || []).slice(-3) };
  }
  const r = ROLE[e.role] || ROLE.stagiaire;
  return { name: r.name, tier: r.tier, status: 'On break', job: JOB[e.role] || '' };
}

function paintHover(e) {
  const d = hoverInfo(e), col = TIER_COLOR[d.tier] || TIER_COLOR.other;
  setText(hc.name, d.name);
  hc.chip.hidden = !d.tier; setText(hc.chip, d.tier ? (TIER_LABEL[d.tier] || d.tier) : ''); hc.chip.style.background = col;
  setText(hc.model, d.model); setText(hc.status, d.status); setText(hc.ticket, d.ticket); setText(hc.act, d.act); setText(hc.job, d.job);
  hc.logEl.querySelectorAll('li').forEach((li, i) => { const l = d.log && d.log[i]; li.hidden = !l; setText(li, l ? l.text : ''); });
}

function placeHover(e) {
  const sw = canvas.clientWidth, sh = canvas.clientHeight, s = sw / W, w = hc.el.offsetWidth, h = hc.el.offsetHeight, gap = 6;
  let x = (e.x + 17) * s + gap, y = (e.y - 8) * s - h - gap; // above and to the right of the sprite
  if (x + w > sw) x = (e.x - 1) * s - w - gap;               // no room on the right: flip to the left
  if (y < 0) y = (e.y + 16) * s + gap;                        // no room above: drop below the feet
  hc.el.style.left = Math.round(Math.max(0, Math.min(x, sw - w))) + 'px';
  hc.el.style.top = Math.round(Math.max(0, Math.min(y, sh - h))) + 'px';
}

function setHover(e) {
  if (e === hc.ent) return;
  hc.ent = e; hc.el.hidden = !e;
  canvas.style.cursor = e ? 'pointer' : '';
  if (e) { paintHover(e); placeHover(e); }
}
function updateHover() { // every frame while shown: follow the monkey, patch the text
  const e = hc.ent;
  if (!e) return;
  if (e.hidden || !monkeys.includes(e)) { setHover(null); return; }
  paintHover(e); placeHover(e);
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
  lineOpen.add(id); paintEnt(ent);
  ent.el.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
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

let watching = null, lastAll = null;
function onSnapshot(all) {
  lastAll = all;
  const sel = $('session-pick'), ids = all.sessions.map(x => x.id);
  if (watching && !ids.includes(watching)) watching = null;
  sel.hidden = all.sessions.length < 2;
  sel.innerHTML = '<option value="">Latest session</option>' + all.sessions.map(x =>
    `<option value="${esc(x.id)}"${x.id === watching ? ' selected' : ''}>${esc(x.project)} · ${esc(x.id.slice(0, 6))}</option>`).join('');
  applyState(Object.assign({}, all.sessions.find(x => x.id === watching) || all.sessions[0] || {}, { now: all.now }));
}
function connect() {
  const es = new EventSource('/events');
  es.onopen = () => { $('conn').classList.add('live'); $('closed').hidden = true; };
  es.onmessage = e => onSnapshot(JSON.parse(e.data));
  es.onerror = () => { $('conn').classList.remove('live'); $('closed').hidden = false; };
}

resetWorld();
resize();
window.addEventListener('resize', resize);
$('session-pick').addEventListener('change', e => { watching = e.target.value || null; if (lastAll) onSnapshot(lastAll); });
requestAnimationFrame(frame);
connect();
