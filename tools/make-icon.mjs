// Generates .claude-plugin/icon.png: the Head Chef monkey from web/art.js,
// scaled up with hard pixel edges on the page's cream background.
// Node built-ins only. Run from anywhere: `node tools/make-icon.mjs`.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import zlib from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, '.claude-plugin', 'icon.png');

const SIZE = 1024;
const BG = '#f2b84b';
const SW = 18, SH = 24; // sprite canvas, as monkeySprite makes it

// ---------- colours ----------
function parseColor(s) {
  s = String(s).trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) return [...m[1]].map(h => parseInt(h + h, 16)).concat(255);
  m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) return [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16)).concat(255);
  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s);
  if (m) return [+m[1], +m[2], +m[3]].map(v => Math.round(v)).concat(m[4] === undefined ? 255 : Math.round(+m[4] * 255));
  throw new Error(`unsupported colour: ${s}`);
}

// ---------- a fake 2D context that only knows fillRect ----------
// Supports translation only (integer offsets); paintMonkey for 'down' needs nothing else.
function makeContext(w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  let tx = 0, ty = 0, rgba = [0, 0, 0, 255];
  return {
    data, width: w, height: h,
    set fillStyle(v) { rgba = parseColor(v); },
    get fillStyle() { return rgba; },
    translate(x, y) { tx += x; ty += y; },
    setTransform(a, b, c, d, e, f) {
      if (a !== 1 || b !== 0 || c !== 0 || d !== 1) throw new Error('only translation transforms are supported');
      tx = e; ty = f;
    },
    scale(sx, sy) { if (sx !== 1 || sy !== 1) throw new Error('scale is not supported'); },
    fillRect(x, y, rw, rh) {
      const x0 = Math.max(0, x + tx), y0 = Math.max(0, y + ty);
      const x1 = Math.min(w, x + tx + rw), y1 = Math.min(h, y + ty + rh);
      const a = rgba[3] / 255;
      for (let py = y0; py < y1; py++) for (let px = x0; px < x1; px++) {
        const i = (py * w + px) * 4;
        if (a >= 1) { data[i] = rgba[0]; data[i + 1] = rgba[1]; data[i + 2] = rgba[2]; data[i + 3] = 255; continue; }
        // source-over for translucent fills
        const da = data[i + 3] / 255, oa = a + da * (1 - a);
        for (let k = 0; k < 3; k++) data[i + k] = oa ? (rgba[k] * a + data[i + k] * da * (1 - a)) / oa : 0;
        data[i + 3] = oa * 255;
      }
    },
  };
}

// ---------- load the page's art ----------
const src = readFileSync(join(ROOT, 'web', 'art.js'), 'utf8');
const sandbox = {
  document: { createElement: () => { const cv = { width: 0, height: 0, getContext: () => makeContext(cv.width, cv.height) }; return cv; } },
  Map, Math, String, Object, Array, Number, parseInt,
};
vm.createContext(sandbox);
const art = vm.runInContext(`${src}\n;({ paintMonkey, INK });`, sandbox, { filename: 'web/art.js' });

// ---------- the sprite, with the page's outline ----------
const sprite = makeContext(SW, SH);
sprite.translate(1, 1);
art.paintMonkey(sprite, 'head-chef', 'down', 0, false);
sprite.setTransform(1, 0, 0, 1, 0, 0);
{
  const d = sprite.data, solid = (x, y) => x >= 0 && y >= 0 && x < SW && y < SH && d[(y * SW + x) * 4 + 3] > 0;
  const edge = [];
  for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++)
    if (!solid(x, y) && (solid(x + 1, y) || solid(x - 1, y) || solid(x, y + 1) || solid(x, y - 1))) edge.push([x, y]);
  sprite.fillStyle = art.INK;
  for (const [x, y] of edge) sprite.fillRect(x, y, 1, 1);
}

// ---------- compose 1024x1024 ----------
const img = new Uint8Array(SIZE * SIZE * 4);
const bg = parseColor(BG), ink = parseColor(art.INK);
const put = (x, y, c) => { const i = (y * SIZE + x) * 4; img[i] = c[0]; img[i + 1] = c[1]; img[i + 2] = c[2]; img[i + 3] = 255; };

// cream fill with a rounded INK frame inset from the edge (hard edges, no AA)
const INSET = 40, THICK = 24, RAD = 120;
const inRounded = (x, y, x0, y0, x1, y1, r) => {
  if (x < x0 || y < y0 || x > x1 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r), cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
  const px = x + 0.5, py = y + 0.5;
  const outer = inRounded(px, py, INSET, INSET, SIZE - INSET, SIZE - INSET, RAD);
  const inner = inRounded(px, py, INSET + THICK, INSET + THICK, SIZE - INSET - THICK, SIZE - INSET - THICK, RAD - THICK);
  put(x, y, outer && !inner ? ink : bg);
}

// sprite, integer nearest-neighbour scale to about 70% of the height, centred
const K = Math.floor((SIZE * 0.7) / SH); // 29 -> 696 px tall
const ox = Math.floor((SIZE - SW * K) / 2), oy = Math.floor((SIZE - SH * K) / 2);
for (let sy = 0; sy < SH; sy++) for (let sx = 0; sx < SW; sx++) {
  const i = (sy * SW + sx) * 4;
  if (sprite.data[i + 3] === 0) continue;
  const c = [sprite.data[i], sprite.data[i + 1], sprite.data[i + 2]];
  for (let y = 0; y < K; y++) for (let x = 0; x < K; x++) put(ox + sx * K + x, oy + sy * K + y, c);
}

// ---------- PNG encoding ----------
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, body) {
  const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
  const tb = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(tb));
  return Buffer.concat([len, tb, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGBA, deflate, filter 0, no interlace
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: none
  Buffer.from(img.buffer, y * SIZE * 4, SIZE * 4).copy(raw, y * (SIZE * 4 + 1) + 1);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, png);
console.log(`wrote ${OUT} (${SIZE}x${SIZE}, ${png.length} bytes, sprite scale ${K})`);
