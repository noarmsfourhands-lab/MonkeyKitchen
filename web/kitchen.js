// Monkey Kitchen front end. A small top-down simulation: every agent is a
// monkey that walks to the part of the kitchen matching what it is doing.
// State arrives as snapshots over /events; art.js does the drawing.

const ROLES = [
  { id: 'head-chef', name: 'Head Chef', tier: 'fable' },
  { id: 'sous-chef', name: 'Sous Chef', tier: 'opus' },
  { id: 'frontend-cook', name: 'Pastry Chef', tier: 'sonnet' },
  { id: 'backend-cook', name: 'Grill Cook', tier: 'sonnet' },
  { id: 'line-cook', name: 'Line Cook', tier: 'sonnet' },
  { id: 'taster', name: 'Taster', tier: 'sonnet' },
  { id: 'inspector', name: 'Inspector', tier: 'opus' },
  { id: 'prep-cook', name: 'Prep Cook', tier: 'haiku' },
  { id: 'runner', name: 'Runner', tier: 'haiku' },
  { id: 'dishwasher', name: 'Dishwasher', tier: 'haiku' },
  { id: 'scribe', name: 'Menu Scribe', tier: 'haiku' },
  { id: 'stagiaire', name: 'Stagiaire', tier: 'guest' },
];
const ROLE = Object.fromEntries(ROLES.map(r => [r.id, r]));
const TIER_LABEL = { fable: 'Fable', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', guest: 'Guest', other: 'Other' };
const TIER_COLOR = { fable: '#b77fd0', opus: '#f08a63', sonnet: '#5cc7c7', haiku: '#8fd17c', guest: '#b8b8b8', other: '#b8b8b8' };

// Where each kind of work happens. `spots` are the tiles a monkey stands on.
const LOC = {
  shelf: { act: 'read', spots: [[4, 3], [5, 3], [4, 4], [5, 4]] },
  pantry: { act: 'rummage', spots: [[2, 3], [3, 3], [1, 3], [2, 4], [3, 4]] },
  sink: { act: 'wash', spots: [[7, 3], [8, 3]] },
  board: { act: 'chop', spots: [[9, 3], [10, 3]] },
  stove: { act: 'pan', spots: [[11, 3], [12, 3]] },
  oven: { act: 'bake', spots: [[13, 3]] },
  grill: { act: 'grill', spots: [[14, 3], [15, 3]] },
  pastry: { act: 'pipe', spots: [[16, 3], [17, 3]] },
  menu: { act: 'chalk', spots: [[21, 2], [20, 2], [22, 2]] },
  desk: { act: 'plan', spots: [[1, 8], [2, 8]] },
  pot: { act: 'taste', spots: [[9, 5], [10, 5]], face: 'down' },
  spuds: { act: 'peel', spots: [[15, 7], [14, 7], [16, 7]] },
};
const STATION = {
  'prep-cook': 'board', 'backend-cook': 'grill', 'frontend-cook': 'pastry', 'line-cook': 'stove', dishwasher: 'sink',
  taster: 'pot', scribe: 'menu', 'sous-chef': 'desk', runner: 'pantry', stagiaire: 'spuds', inspector: 'patrol',
};
// Where each monkey waits between tickets: most on the break rug, a few dozing near their post.
const HOME = {
  'frontend-cook': [20, 5], 'backend-cook': [22, 5], 'line-cook': [20, 7], 'prep-cook': [22, 7],
  runner: [21, 6], dishwasher: [19, 6], scribe: [23, 7],
  'sous-chef': [3, 8], taster: [7, 6], inspector: [18, 8], stagiaire: [17, 6],
};
const DOOR = [0, 3], CHEF_SPOT = [11, 9];
const PLATE_SLOTS = [9, 14, 7, 16, 5, 18, 3, 20, 8, 15, 6, 17, 4, 19, 10, 13];
const ARMS = new Set(['chop', 'pan', 'grill', 'pipe', 'wash', 'chalk', 'peel', 'rummage', 'place', 'ring', 'wave', 'plate', 'shout', 'bake', 'taste']);
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
  return LOC[name].spots[0];
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
    e.setPlan(intent, [{ set: { carry: null } }, { go: sp, face }, { act: L.act, at: [sp[0], sp[1] + (face === 'up' ? -1 : 1)] }]);
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
    e.label = c.role === 'stagiaire' && c.agentType ? c.agentType : ROLE[c.role].name;
    e.tier = c.tier || ROLE[c.role].tier;
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

const tags = new Map();
function updateTags() {
  const seen = new Set();
  for (const e of monkeys) {
    const show = !e.hidden && e.label && (e !== chef || (live && live.chef && live.chef.status !== 'idle'));
    if (!show) continue;
    seen.add(e);
    let el = tags.get(e);
    if (!el) { el = document.createElement('div'); el.className = 'tag'; $('overlay').appendChild(el); tags.set(e, el); }
    if (el.textContent !== e.label) el.textContent = e.label;
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
  dialogTick(dt);
  requestAnimationFrame(frame);
}

// ---------- text box, side panels ----------

const dialog = { queue: [], text: '', shown: 0, hold: 0, lastKey: null };
function dialogReset() { dialog.queue = []; dialog.text = ''; dialog.shown = 0; dialog.hold = 0; dialog.lastKey = null; $('dialog-text').textContent = ''; }
function dialogPush(text) { dialog.queue.push(text); if (dialog.queue.length > 3) dialog.queue.splice(0, dialog.queue.length - 3); }
function dialogTick(dt) {
  if (dialog.shown < dialog.text.length) {
    dialog.shown = Math.min(dialog.text.length, dialog.shown + dt * 60);
    $('dialog-text').textContent = dialog.text.slice(0, Math.floor(dialog.shown));
  } else if ((dialog.hold -= dt) <= 0 && dialog.queue.length) {
    dialog.text = dialog.queue.shift(); dialog.shown = 0; dialog.hold = 1.3;
  }
}

const fmt = n => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n || 0);
const money = n => '$' + (n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toFixed(3));

function renderPanels(s) {
  live = s;
  const o = s.order || {};
  $('order').className = 'order ' + (o.status || '');
  $('order-text').textContent = o.text || 'No order yet. Send one from Claude Code.';
  $('order-text').title = o.text || '';
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

  // tickets
  const cooks = [...(s.cooks || [])].sort((a, b) => (a.status === 'working' ? 0 : 1) - (b.status === 'working' ? 0 : 1) || b.startedAt - a.startedAt);
  const chefRow = s.chef && s.chef.status !== 'idle'
    ? `<li class="working"><i style="background:${TIER_COLOR.fable}"></i><b>Head Chef</b><span>${esc(s.chef.activity || 'Thinking')}</span></li>` : '';
  $('tickets').innerHTML = chefRow + cooks.slice(0, 14).map(c => {
    const r = ROLE[c.role] || ROLE.stagiaire, name = c.role === 'stagiaire' && c.agentType ? c.agentType : r.name;
    const line = c.status === 'working' ? (c.activity || 'Getting started') : c.status === 'failed' ? 'Sent back' : 'Plated';
    return `<li class="${c.status}"><i style="background:${TIER_COLOR[c.tier || r.tier]}" title="${esc(TIER_LABEL[c.tier || r.tier] || '')}"></i><b>${esc(name)}</b><em>${esc(c.ticket || '')}</em><span>${esc(line)}</span></li>`;
  }).join('') || '<li class="muted">No tickets on the rail</li>';

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

  $('feed').innerHTML = feed.slice().reverse().map(f => {
    const t = new Date(f.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return `<li class="${f.fail ? 'fail' : ''}"><time>${t}</time><b>${esc((ROLE[f.who] || ROLE.stagiaire).name)}</b> ${esc(f.text)}</li>`;
  }).join('');
}

// ---------- session picker + live connection ----------

let watching = null, lastAll = null;
function onSnapshot(all) {
  lastAll = all;
  const sel = $('session-pick'), ids = all.sessions.map(x => x.id);
  if (watching && !ids.includes(watching)) watching = null;
  sel.hidden = all.sessions.length < 2;
  sel.innerHTML = '<option value="">Latest session</option>' + all.sessions.map(x =>
    `<option value="${esc(x.id)}"${x.id === watching ? ' selected' : ''}>${esc(x.project)} · ${esc(x.id.slice(0, 6))}</option>`).join('');
  applyState(all.sessions.find(x => x.id === watching) || all.sessions[0] || {});
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
