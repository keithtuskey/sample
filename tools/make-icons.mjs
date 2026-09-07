// Generates Tucky's PNG icons with no external dependencies.
// A graphite rounded square with three amber note cards fanned out from the edge.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const OUT = new URL('../extension/src/icons/', import.meta.url);
mkdirSync(OUT, { recursive: true });

const SS = 4; // supersampling factor for cheap anti-aliasing

function crc32(buf) {
  let c, table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // truecolour with alpha
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Signed distance to a rounded rectangle centred at (cx, cy), rotated by `rot`.
function inRoundedRect(px, py, cx, cy, w, h, r, rot = 0) {
  const dx = px - cx, dy = py - cy;
  const c = Math.cos(-rot), s = Math.sin(-rot);
  const x = Math.abs(dx * c - dy * s) - (w / 2 - r);
  const y = Math.abs(dx * s + dy * c) - (h / 2 - r);
  const qx = Math.max(x, 0), qy = Math.max(y, 0);
  return Math.hypot(qx, qy) + Math.min(Math.max(x, y), 0) - r <= 0;
}

const BG = [28, 25, 23];             // stone-900
const CARDS = [
  { rot: -0.34, dx: -0.20, dy: 0.03, rgb: [120, 53, 15] },   // amber-900, tucked behind
  { rot: -0.17, dx: -0.10, dy: 0.015, rgb: [217, 119, 6] },  // amber-600
  { rot: 0.0,   dx: 0.02,  dy: 0.0,  rgb: [251, 191, 36] },  // amber-400, the one you pick
];

function render(size) {
  const S = size * SS;
  const acc = new Float32Array(size * size * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const px = (x + 0.5) / S, py = (y + 0.5) / S; // normalised 0..1
      let rgb = null, a = 0;
      if (inRoundedRect(px, py, 0.5, 0.5, 0.94, 0.94, 0.24)) { rgb = BG; a = 1; }
      for (const card of CARDS) {
        if (inRoundedRect(px, py, 0.47 + card.dx, 0.5 + card.dy, 0.30, 0.60, 0.07, card.rot)) {
          rgb = card.rgb; a = 1;
        }
      }
      // The stripe Tucky sleeps as, along the right edge.
      if (inRoundedRect(px, py, 0.845, 0.5, 0.075, 0.52, 0.037)) { rgb = [245, 245, 244]; a = 1; }
      if (!rgb) continue;
      const i = ((y / SS | 0) * size + (x / SS | 0)) * 4;
      acc[i] += rgb[0]; acc[i + 1] += rgb[1]; acc[i + 2] += rgb[2]; acc[i + 3] += a * 255;
    }
  }
  const n = SS * SS;
  const out = Buffer.alloc(size * size * 4);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = Math.round(acc[i] / n);
    out[i + 1] = Math.round(acc[i + 1] / n);
    out[i + 2] = Math.round(acc[i + 2] / n);
    out[i + 3] = Math.round(acc[i + 3] / n);
  }
  return out;
}

for (const size of [16, 32, 48, 128]) {
  writeFileSync(new URL(`icon${size}.png`, OUT), png(size, render(size)));
  console.log(`wrote icon${size}.png`);
}
