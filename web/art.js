// Pixel art for the kitchen: tiles, furniture, monkey sprites, emotes.
// Everything is drawn with rectangles in "world pixels" (16 per tile); the
// caller scales the canvas context, so nothing here knows the screen size.

const T = 16, COLS = 24, ROWS = 14;
const W = COLS * T, H = ROWS * T;
const INK = '#2b2233';

function R(ctx, x, y, w, h, c) { ctx.fillStyle = c; ctx.fillRect(x, y, w, h); }

// ---------- map ----------
// Where things are, in tiles. Used by the drawing code and the walk grid.
const MAP = {
  door: { x: 0 }, pantry: { x: 1, w: 2 }, fridge: { x: 3 }, books: { x: 4, w: 2 },
  sink: { x: 7, w: 2 }, board: { x: 9, w: 2 }, stove: { x: 11, w: 2 }, oven: { x: 13 },
  grill: { x: 14, w: 2 }, pastry: { x: 16, w: 2 }, counterEnd: 18,
  island: { x: 8, w: 9, y: 6 }, pot: { x: 9 }, bowl: { x: 12 }, spuds: { x: 15 },
  desk: { x: 1, w: 2, y: 7 }, rug: { x: 19, y: 4, w: 5, h: 5 }, crate: { x: 23, y: 4 },
  pass: { x: 2, w: 20, y: 10 }, bell: { x: 12 }, table: { x: 11, y: 12 },
  rail: { x: 8, w: 8 }, menu: { x: 20, w: 3 }, pans: { x: 6 }, window: { x: 16 }, clock: { x: 18 },
};
const STOOLS = [[20, 5], [22, 5], [20, 7], [22, 7]];

function isBlocked(x, y) {
  if (x < 0 || y < 2 || x >= COLS || y >= MAP.pass.y) return true;
  if (y === 2 && x <= MAP.counterEnd) return true;
  if (y === MAP.island.y && x >= MAP.island.x && x < MAP.island.x + MAP.island.w) return true;
  if (y === MAP.desk.y && x >= MAP.desk.x && x < MAP.desk.x + MAP.desk.w) return true;
  if (x === MAP.crate.x && y === MAP.crate.y) return true;
  return false;
}

// ---------- furniture ----------

function counter(ctx, tx, ty, top = '#cdd6dc', hi = '#eef3f6', front = '#98a4ae', edge = '#6f7b86') {
  const x = tx * T, y = ty * T;
  R(ctx, x, y, T, 9, top); R(ctx, x, y, T, 2, hi);
  R(ctx, x, y + 9, T, 7, front); R(ctx, x, y + 9, T, 1, edge); R(ctx, x, y + 15, T, 1, edge);
  R(ctx, x, y + 10, 1, 5, edge); R(ctx, x + 7, y + 11, 2, 1, edge);
}
const woodCounter = (ctx, tx, ty) => counter(ctx, tx, ty, '#dba869', '#eec587', '#a8703d', '#7d4f27');

function shelfUnit(ctx, tx, w, items) {
  const x = tx * T, y = T, ww = w * T;
  R(ctx, x, y, ww, 32, '#7d4f27'); R(ctx, x + 1, y + 1, ww - 2, 30, '#4a2f18');
  for (let s = 0; s < 3; s++) {
    const sy = y + 9 + s * 10;
    R(ctx, x + 1, sy, ww - 2, 2, '#a8703d');
    items(x + 2, sy, ww - 4, s);
  }
}

function drawBackground(ctx) {
  // floors
  for (let ty = 2; ty < ROWS; ty++) for (let tx = 0; tx < COLS; tx++) {
    const x = tx * T, y = ty * T;
    if (ty > MAP.pass.y) {
      R(ctx, x, y, T, T, '#c58f5a');
      for (let i = 0; i < 4; i++) R(ctx, x, y + i * 4 + 3, T, 1, '#a8733f');
      R(ctx, x + ((ty * 5 + tx * 3) % 12) + 2, y, 1, 3, '#a8733f'); R(ctx, x + ((ty * 7 + tx) % 12) + 2, y + 8, 1, 3, '#a8733f');
    } else {
      R(ctx, x, y, T, T, (tx + ty) % 2 ? '#efe2c4' : '#e2d0a8');
      R(ctx, x + T - 1, y, 1, T, '#d2bf95'); R(ctx, x, y + T - 1, T, 1, '#d2bf95');
    }
  }

  // back wall: dark cap, then white tile
  R(ctx, 0, 0, W, T, '#4b3b57'); R(ctx, 0, 0, W, 3, '#3a2d45'); R(ctx, 0, T - 2, W, 2, INK);
  R(ctx, 0, T, W, T, '#eef3f2');
  for (let x = 0; x < W; x += 8) { R(ctx, x, T, 1, 8, '#c5d0d4'); R(ctx, x + 4, T + 8, 1, 8, '#c5d0d4'); }
  R(ctx, 0, T + 7, W, 1, '#c5d0d4'); R(ctx, 0, T + 15, W, 1, '#aab6bb');
  // the stretch of wall with no counter in front of it runs down one more row's worth of baseboard
  R(ctx, (MAP.counterEnd + 1) * T, 2 * T, W, 2, '#8a96a1');

  // wall fittings
  for (let i = 0; i < 2; i++) { // hanging pans
    const x = (MAP.pans.x + i) * T + 3;
    R(ctx, x + 4, T + 1, 1, 4, '#6f7b86'); R(ctx, x + 1, T + 5, 8, 7, INK); R(ctx, x + 2, T + 6, 6, 5, i ? '#8a5a2e' : '#555b68');
  }
  R(ctx, MAP.rail.x * T + 2, T + 3, MAP.rail.w * T - 4, 2, '#8a96a1'); R(ctx, MAP.rail.x * T + 2, T + 5, MAP.rail.w * T - 4, 1, '#5c6670');
  { // window
    const x = MAP.window.x * T + 1, y = T + 1;
    R(ctx, x, y, 30, 13, '#7d4f27'); R(ctx, x + 2, y + 2, 26, 9, '#bfe6f7'); R(ctx, x + 14, y + 2, 2, 9, '#7d4f27');
    R(ctx, x + 20, y + 3, 4, 4, '#ffe27a'); R(ctx, x + 3, y + 8, 9, 3, '#8fd17c');
  }
  { // clock
    const x = MAP.clock.x * T + 3, y = T + 2;
    R(ctx, x, y, 10, 10, INK); R(ctx, x + 1, y + 1, 8, 8, '#fff8ea'); R(ctx, x + 4, y + 2, 1, 4, INK); R(ctx, x + 4, y + 5, 3, 1, INK);
  }
  { // menu chalkboard
    const x = MAP.menu.x * T + 1, y = T + 1;
    R(ctx, x, y, MAP.menu.w * T - 2, 14, '#7d4f27'); R(ctx, x + 2, y + 2, MAP.menu.w * T - 6, 10, '#2f4f3a');
  }

  // door, pantry, fridge, recipe shelf (all two tiles tall, standing against the wall)
  R(ctx, 0, T, T, 32, '#4a2f18'); R(ctx, 2, T + 2, 12, 30, '#9a6a3c'); R(ctx, 4, T + 5, 8, 8, '#bfe6f7'); R(ctx, 11, T + 18, 2, 2, '#e7c94a');
  const jar = ['#e8792e', '#6cbf4b', '#e7c94a', '#d9534f', '#7cc6ea', '#f3ecef'];
  shelfUnit(ctx, MAP.pantry.x, 2, (x, sy, w, s) => {
    for (let i = 0; i * 5 < w - 3; i++) { const h = 4 + ((i + s) % 3); R(ctx, x + i * 5, sy - h, 4, h, jar[(i * 2 + s) % 6]); R(ctx, x + i * 5, sy - h, 4, 1, '#fff8ea'); }
  });
  shelfUnit(ctx, MAP.books.x, 2, (x, sy, w, s) => {
    let bx = x;
    for (let i = 0; bx < x + w - 2; i++) { const bw = 2 + ((i + s) % 2), h = 5 + ((i * 3 + s) % 3); R(ctx, bx, sy - h, bw, h, jar[(i + s * 2) % 6]); bx += bw + ((i % 4) === 3 ? 2 : 0); }
  });
  { // fridge
    const x = MAP.fridge.x * T, y = T;
    R(ctx, x, y, T, 32, INK); R(ctx, x + 1, y + 1, 14, 30, '#dfe7ec'); R(ctx, x + 1, y + 1, 14, 2, '#fff');
    R(ctx, x + 1, y + 11, 14, 1, '#8a96a1'); R(ctx, x + 12, y + 4, 1, 5, '#5c6670'); R(ctx, x + 12, y + 14, 1, 9, '#5c6670'); R(ctx, x + 1, y + 29, 14, 2, '#aab6bb');
  }

  // the line: counters and appliances along the back wall
  for (let tx = MAP.books.x + 2; tx <= MAP.counterEnd; tx++) counter(ctx, tx, 2);
  for (let i = 0; i < 2; i++) { // sink
    const x = (MAP.sink.x + i) * T, y = 2 * T;
    R(ctx, x + 2, y + 1, 12, 7, '#5c6670'); R(ctx, x + 3, y + 2, 10, 5, '#7cc6ea'); R(ctx, x + 3, y + 2, 10, 1, '#b7e2f6'); R(ctx, x + 7, y - 2, 2, 5, '#eef3f6'); R(ctx, x + 7, y + 2, 2, 1, '#aab6bb');
  }
  { // cutting boards
    let x = MAP.board.x * T, y = 2 * T;
    R(ctx, x + 2, y + 1, 12, 6, '#d9a066'); R(ctx, x + 2, y + 6, 12, 1, '#a8703d'); R(ctx, x + 4, y + 3, 5, 1, '#e8792e'); R(ctx, x + 9, y + 3, 2, 1, '#4f9a3c');
    x += T; R(ctx, x + 2, y + 1, 12, 6, '#d9a066'); R(ctx, x + 2, y + 6, 12, 1, '#a8703d'); R(ctx, x + 5, y + 2, 5, 3, '#6cbf4b'); R(ctx, x + 6, y + 2, 2, 1, '#a6e08a');
  }
  for (let i = 0; i < 2; i++) { // stove
    const x = (MAP.stove.x + i) * T, y = 2 * T;
    R(ctx, x, y, T, 9, '#3a3f4a'); R(ctx, x, y, T, 1, '#555b68'); R(ctx, x + 3, y + 2, 10, 6, '#1f2228'); R(ctx, x + 5, y + 3, 6, 4, '#4a505c');
    R(ctx, x + 3, y + 11, 2, 2, '#d9534f'); R(ctx, x + 7, y + 11, 2, 2, '#d9534f'); R(ctx, x + 11, y + 11, 2, 2, '#d9534f');
  }
  { // oven
    const x = MAP.oven.x * T, y = 2 * T;
    R(ctx, x + 1, y + 10, 14, 5, '#2a2d34'); R(ctx, x + 3, y + 11, 10, 3, '#51402a'); R(ctx, x + 3, y + 10, 10, 1, '#8a96a1');
  }
  for (let i = 0; i < 2; i++) { // grill
    const x = (MAP.grill.x + i) * T, y = 2 * T;
    R(ctx, x, y, T, 9, '#2a2d34'); for (let r = 2; r < 8; r += 2) R(ctx, x + 1, y + r, 14, 1, '#b5522c');
  }
  { // pastry bench
    let x = MAP.pastry.x * T, y = 2 * T;
    for (let i = 0; i < 2; i++) { R(ctx, x + i * T, y, T, 9, '#f3ecef'); R(ctx, x + i * T + 3, y + 4, 4, 1, '#d9cdd3'); R(ctx, x + i * T + 9, y + 6, 5, 1, '#d9cdd3'); }
    R(ctx, x + 3, y + 5, 10, 2, '#fff'); R(ctx, x + 4, y, 8, 6, '#f2a7c0'); R(ctx, x + 4, y, 8, 2, '#fff8ea'); R(ctx, x + 7, y - 1, 2, 1, '#d33');
    x += T; for (let i = 0; i < 3; i++) { R(ctx, x + 2 + i * 4, y + 4, 3, 3, '#d9a066'); R(ctx, x + 2 + i * 4, y + 2, 3, 2, ['#f2a7c0', '#fff8ea', '#b7e2f6'][i]); }
  }

  // island
  for (let i = 0; i < MAP.island.w; i++) woodCounter(ctx, MAP.island.x + i, MAP.island.y);
  { const y = MAP.island.y * T;
    let x = MAP.pot.x * T; R(ctx, x + 2, y - 3, 12, 9, INK); R(ctx, x + 3, y - 2, 10, 7, '#6f7b86'); R(ctx, x + 3, y - 2, 10, 2, '#e8792e'); R(ctx, x, y, 2, 2, INK); R(ctx, x + 14, y, 2, 2, INK);
    x = MAP.bowl.x * T; R(ctx, x + 3, y + 1, 10, 5, '#fff8ea'); R(ctx, x + 4, y + 1, 8, 2, '#e7c94a'); R(ctx, x + 4, y + 6, 8, 1, '#c9bfa6');
    x = MAP.spuds.x * T; for (const [dx, dy] of [[2, 3], [6, 1], [10, 3], [5, 4], [9, 0]]) { R(ctx, x + dx, y + dy, 4, 3, '#b08a56'); R(ctx, x + dx + 1, y + dy, 2, 1, '#d2b07a'); }
  }
  // sous chef's planning desk
  for (let i = 0; i < 2; i++) woodCounter(ctx, MAP.desk.x + i, MAP.desk.y);
  { const x = MAP.desk.x * T, y = MAP.desk.y * T; R(ctx, x + 3, y + 1, 22, 6, '#3b6fb5'); R(ctx, x + 5, y + 2, 8, 1, '#cfe2ff'); R(ctx, x + 5, y + 4, 14, 1, '#cfe2ff'); R(ctx, x + 16, y + 2, 5, 3, '#cfe2ff'); R(ctx, x + 27, y + 2, 1, 5, '#e7c94a'); }

  // break corner
  { const x = MAP.rug.x * T + 2, y = MAP.rug.y * T + 2, w = MAP.rug.w * T - 4, h = MAP.rug.h * T - 4;
    R(ctx, x, y, w, h, '#b5524a'); R(ctx, x + 2, y + 2, w - 4, 1, '#e7c94a'); R(ctx, x + 2, y + h - 3, w - 4, 1, '#e7c94a'); R(ctx, x + 2, y + 2, 1, h - 4, '#e7c94a'); R(ctx, x + w - 3, y + 2, 1, h - 4, '#e7c94a');
    for (let i = 6; i < w - 6; i += 8) { R(ctx, x + i, y + 6, 3, 3, '#d97a6c'); R(ctx, x + i, y + h - 9, 3, 3, '#d97a6c'); }
  }
  for (const [tx, ty] of STOOLS) { const x = tx * T, y = ty * T; R(ctx, x + 3, y + 8, 10, 7, INK); R(ctx, x + 4, y + 9, 8, 5, '#a8703d'); R(ctx, x + 4, y + 9, 8, 2, '#dba869'); }
  { const x = MAP.crate.x * T, y = MAP.crate.y * T; R(ctx, x + 1, y + 4, 14, 12, INK); R(ctx, x + 2, y + 5, 12, 10, '#a8703d'); R(ctx, x + 2, y + 9, 12, 1, '#7d4f27'); R(ctx, x + 3, y + 2, 4, 4, '#f4d03f'); R(ctx, x + 7, y + 1, 5, 4, '#f4d03f'); R(ctx, x + 9, y + 3, 4, 3, '#e0b62a'); }

  // the pass
  R(ctx, 0, MAP.pass.y * T, W, T, '#4b3b57'); R(ctx, 0, MAP.pass.y * T, W, 3, '#3a2d45'); R(ctx, 0, MAP.pass.y * T + T - 2, W, 2, INK);
  for (let i = 0; i < MAP.pass.w; i++) { counter(ctx, MAP.pass.x + i, MAP.pass.y, '#d9dfe4'); R(ctx, (MAP.pass.x + i) * T, MAP.pass.y * T + 2, T, 1, '#f6d28a'); }
  { const x = MAP.bell.x * T, y = MAP.pass.y * T; R(ctx, x + 4, y + 6, 8, 2, '#8a6a12'); R(ctx, x + 5, y + 2, 6, 4, '#e7c94a'); R(ctx, x + 6, y + 2, 2, 1, '#fff3b0'); R(ctx, x + 7, y, 2, 2, '#8a6a12'); }

  // dining room: three tables, yours in the middle
  for (const tx of [4, MAP.table.x, 18]) {
    const x = tx * T, y = MAP.table.y * T;
    R(ctx, x - 1, y - 1, 34, 14, INK);
    for (let i = 0; i < 8; i++) for (let j = 0; j < 3; j++) R(ctx, x + i * 4, y + j * 4, 4, 4, (i + j) % 2 ? '#d9534f' : '#fff8ea');
    R(ctx, x + 2, y + 13, 3, 3, '#7d4f27'); R(ctx, x + 27, y + 13, 3, 3, '#7d4f27');
    if (tx !== MAP.table.x) { R(ctx, x + 15, y + 2, 2, 5, '#fff8ea'); R(ctx, x + 15, y, 2, 2, '#ffb347'); }
  }
}

// ---------- monkeys ----------

const STYLE = {
  'head-chef': { fur: '#6b4226', hat: 'tall', band: '#e7c94a', moustache: true },
  'sous-chef': { fur: '#7a4b2a', hat: 'toque', band: '#d9542b' },
  'chef-de-partie': { fur: '#4f3320', hat: 'toque', band: '#8e44ad' },
  'line-cook': { fur: '#8b5a2b', hat: 'toque', band: '#aab6bb' },
  'frontend-cook': { fur: '#b9794a', hat: 'beret', c: '#f08db0' },
  'backend-cook': { fur: '#5e3d24', hat: 'bandana', c: '#d33f3f' },
  'prep-cook': { fur: '#a06a3a', hat: 'cap', c: '#5fae4a' },
  dishwasher: { fur: '#8f8780', hat: 'bandana', c: '#3f7fd3', apron: '#bfe0f5' },
  taster: { fur: '#9a6238', hat: 'toque', band: '#1f8a8a' },
  inspector: { fur: '#6f665f', hat: 'flat', c: '#3d4a5c', apron: '#55606e' },
  scribe: { fur: '#7d5a44', hat: 'beret', c: '#8e5fc0' },
  runner: { fur: '#b5651d', hat: 'headband', c: '#e7c94a', apron: '#f0b24a' },
  stagiaire: { fur: '#c4a484', hat: 'paper' },
  customer: { fur: '#8b5a2b', hat: 'none', apron: '#3f7fd3' },
};
const shade = (hex, k) => '#' + [1, 3, 5].map(i => Math.max(0, Math.min(255, Math.round(parseInt(hex.slice(i, i + 2), 16) * k))).toString(16).padStart(2, '0')).join('');

function drawHat(c, st) {
  const Wt = '#fff8ea';
  switch (st.hat) {
    case 'tall': R(c, 4, 0, 8, 5, Wt); R(c, 3, 0, 10, 3, Wt); R(c, 4, 3, 1, 2, '#d8cfbd'); R(c, 4, 5, 8, 1, st.band); break;
    case 'toque': R(c, 4, 2, 8, 3, Wt); R(c, 3, 1, 4, 3, Wt); R(c, 6, 0, 4, 3, Wt); R(c, 9, 1, 4, 3, Wt); R(c, 4, 5, 8, 1, st.band); break;
    case 'beret': R(c, 3, 4, 10, 2, st.c); R(c, 5, 3, 7, 1, st.c); R(c, 8, 2, 1, 1, st.c); break;
    case 'bandana': R(c, 3, 5, 10, 2, st.c); R(c, 5, 5, 2, 1, shade(st.c, 1.4)); R(c, 12, 7, 2, 2, st.c); break;
    case 'cap': R(c, 4, 4, 8, 2, st.c); R(c, 3, 6, 10, 1, shade(st.c, .7)); break;
    case 'headband': R(c, 3, 6, 10, 1, st.c); R(c, 13, 6, 2, 1, st.c); break;
    case 'flat': R(c, 3, 4, 10, 2, st.c); R(c, 2, 6, 8, 1, shade(st.c, .7)); break;
    case 'paper': R(c, 5, 2, 6, 3, Wt); R(c, 4, 5, 8, 1, Wt); R(c, 7, 1, 2, 1, Wt); R(c, 4, 5, 8, 1, '#d8cfbd'); break;
  }
}

// frame: 0 stand, 1/2 walk, 3/4 working (one arm up, then the other)
function paintMonkey(c, role, dir, frame, asleep) {
  const st = STYLE[role] || STYLE.stagiaire;
  const F = st.fur, Fd = shade(F, .65), Tn = '#f3d2a4', A = st.apron || '#fff8ea';
  const feet = () => {
    const l = frame === 1 ? 1 : 2, r = frame === 2 ? 1 : 2;
    R(c, 4, 19, 3, l, Fd); R(c, 9, 19, 3, r, Fd);
  };
  const arm = (x, up) => { if (up) { R(c, x, 10, 2, 4, F); R(c, x, 9, 2, 1, Tn); } else { R(c, x, 13, 2, 5, F); R(c, x, 17, 2, 1, Tn); } };

  if (dir === 'left') {
    R(c, 12, 16, 2, 1, F); R(c, 13, 13, 1, 3, F);                 // tail
    R(c, 11, 8, 2, 3, F);                                         // far ear
    R(c, 3, 6, 10, 7, F); R(c, 2, 7, 11, 5, F);                   // head
    R(c, 2, 8, 6, 4, Tn); R(c, 3, 7, 3, 1, Tn);                   // face
    if (asleep) R(c, 4, 10, 2, 1, INK); else R(c, 4, 9, 1, 2, INK);
    R(c, 2, 11, 2, 1, '#a8604a');
    R(c, 5, 13, 7, 6, F); R(c, 4, 13, 4, 6, A);                   // body, apron
    if (frame >= 3) { R(c, 2, 12 + (frame - 3), 5, 2, F); R(c, 1, 12 + (frame - 3), 1, 2, Tn); } else { R(c, 7, 13, 2, 5, F); R(c, 7, 17, 2, 1, Tn); }
    R(c, 4, 19, 3, frame === 1 ? 1 : 2, Fd); R(c, 8, 19, 3, frame === 2 ? 1 : 2, Fd);
    drawHat(c, st);
    return;
  }
  // tail
  R(c, 13, 16, 2, 1, F); R(c, 14, 14, 1, 2, F); R(c, 15, 13, 1, 1, F);
  // ears
  R(c, 1, 8, 2, 3, F); R(c, 13, 8, 2, 3, F);
  // head
  R(c, 3, 6, 10, 7, F); R(c, 2, 7, 12, 5, F);
  R(c, 4, 13, 8, 6, F);
  if (dir === 'down') {
    R(c, 1, 9, 1, 1, Tn); R(c, 14, 9, 1, 1, Tn);
    R(c, 4, 8, 8, 4, Tn); R(c, 5, 7, 2, 1, Tn); R(c, 9, 7, 2, 1, Tn);
    if (asleep) { R(c, 5, 10, 2, 1, INK); R(c, 9, 10, 2, 1, INK); } else { R(c, 5, 9, 1, 2, INK); R(c, 10, 9, 1, 2, INK); }
    R(c, 7, 11, 2, 1, '#a8604a');
    if (st.moustache) { R(c, 5, 11, 6, 1, INK); R(c, 4, 12, 2, 1, INK); R(c, 10, 12, 2, 1, INK); }
    R(c, 5, 13, 6, 6, A); R(c, 5, 13, 6, 1, shade(A, .85));
  } else {
    R(c, 5, 15, 6, 1, A); R(c, 7, 13, 2, 2, A); // apron strings
  }
  arm(2, frame === 3); arm(12, frame === 4);
  feet();
  drawHat(c, st);
}

const spriteCache = new Map();
function monkeySprite(role, dir, frame, asleep) {
  const key = `${role}|${dir}|${frame}|${asleep ? 1 : 0}`;
  let cv = spriteCache.get(key);
  if (cv) return cv;
  cv = document.createElement('canvas'); cv.width = 18; cv.height = 24;
  const c = cv.getContext('2d');
  c.translate(1, 1);
  if (dir === 'right') { c.translate(16, 0); c.scale(-1, 1); paintMonkey(c, role, 'left', frame, asleep); }
  else paintMonkey(c, role, dir, frame, asleep);
  c.setTransform(1, 0, 0, 1, 0, 0);
  // dark outline around the silhouette, the way old handheld sprites were drawn
  const img = c.getImageData(0, 0, 18, 24), d = img.data, solid = (x, y) => x >= 0 && y >= 0 && x < 18 && y < 24 && d[(y * 18 + x) * 4 + 3] > 0;
  const edge = [];
  for (let y = 0; y < 24; y++) for (let x = 0; x < 18; x++) if (!solid(x, y) && (solid(x + 1, y) || solid(x - 1, y) || solid(x, y + 1) || solid(x, y - 1))) edge.push([x, y]);
  for (const [x, y] of edge) R(c, x, y, 1, 1, INK);
  spriteCache.set(key, cv);
  return cv;
}

// ---------- small things ----------

const GLYPH = {
  '!': ['..#..', '..#..', '..#..', '.....', '..#..'],
  '?': ['.##..', '...#.', '..#..', '.....', '..#..'],
  '.': ['.....', '.....', '.....', '.....', '#.#.#'],
  z: ['.....', '####.', '..#..', '.#...', '####.'],
  n: ['..##.', '..#.#', '..#..', '###..', '###..'],
  h: ['.#.#.', '#####', '#####', '.###.', '..#..'],
  b: ['.###.', '#####', '#####', '.###.', '.#.#.'],
};
const GLYPH_COLOR = { '!': '#d33f3f', '?': '#3f7fd3', '.': INK, z: '#5b6c8f', n: '#8e5fc0', h: '#e0457b', b: '#e0a81a' };

function drawEmote(ctx, x, y, kind) {
  R(ctx, x + 1, y, 7, 9, INK); R(ctx, x, y + 1, 9, 7, INK); R(ctx, x + 1, y + 1, 7, 7, '#fff'); R(ctx, x + 3, y + 9, 2, 1, INK);
  const g = GLYPH[kind] || GLYPH['!'];
  for (let j = 0; j < 5; j++) for (let i = 0; i < 5; i++) if (g[j][i] === '#') R(ctx, x + 2 + i, y + 2 + j, 1, 1, GLYPH_COLOR[kind] || INK);
}

function drawPlate(ctx, x, y, food = '#e8792e') {
  R(ctx, x, y + 1, 8, 3, INK); R(ctx, x + 1, y, 6, 5, INK); R(ctx, x + 1, y + 1, 6, 3, '#fff'); R(ctx, x + 2, y + 1, 4, 2, food); R(ctx, x + 3, y + 1, 1, 1, '#fff3b0');
}
function drawCrate(ctx, x, y) { R(ctx, x, y, 8, 7, INK); R(ctx, x + 1, y + 1, 6, 5, '#b9854a'); R(ctx, x + 1, y + 3, 6, 1, '#7d4f27'); }
function drawBook(ctx, x, y) { R(ctx, x, y, 7, 5, INK); R(ctx, x + 1, y + 1, 5, 3, '#d9534f'); R(ctx, x + 3, y + 1, 1, 3, '#fff8ea'); }
function drawClipboard(ctx, x, y) { R(ctx, x, y, 6, 7, INK); R(ctx, x + 1, y + 1, 4, 5, '#fff8ea'); R(ctx, x + 2, y + 2, 2, 1, '#8a96a1'); R(ctx, x + 2, y + 4, 2, 1, '#8a96a1'); }
