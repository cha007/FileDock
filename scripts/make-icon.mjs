/**
 * Generates build/icon.png (512×512) with no image dependencies.
 *
 * Everything is drawn with signed-distance shapes into an RGBA buffer that is
 * rendered at 2× and box-filtered down, then encoded as a PNG by hand (zlib is
 * part of Node). It is converted to the Windows .ico by the Tauri bundler.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 512;
const SS = 2; // supersampling factor
const W = SIZE * SS;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const pixels = new Float32Array(W * W * 4); // straight RGBA, 0..1

// ---------------------------------------------------------------- helpers

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function blend(x, y, color, alpha) {
  if (x < 0 || y < 0 || x >= W || y >= W || alpha <= 0) return;
  const i = (y * W + x) * 4;
  const [r, g, b] = color;
  const dstA = pixels[i + 3];
  const outA = alpha + dstA * (1 - alpha);
  if (outA <= 0) return;
  pixels[i] = (r * alpha + pixels[i] * dstA * (1 - alpha)) / outA;
  pixels[i + 1] = (g * alpha + pixels[i + 1] * dstA * (1 - alpha)) / outA;
  pixels[i + 2] = (b * alpha + pixels[i + 2] * dstA * (1 - alpha)) / outA;
  pixels[i + 3] = outA;
}

function paint(shape, color, alpha = 1) {
  const box = shape.bounds();
  const x0 = Math.max(0, Math.floor(box[0]));
  const y0 = Math.max(0, Math.floor(box[1]));
  const x1 = Math.min(W - 1, Math.ceil(box[2]));
  const y1 = Math.min(W - 1, Math.ceil(box[3]));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = shape.distance(x + 0.5, y + 0.5);
      const coverage = clamp(0.5 - d, 0, 1);
      if (coverage > 0) blend(x, y, color, coverage * alpha);
    }
  }
}

function roundRect(cx, cy, hw, hh, r) {
  return {
    distance(px, py) {
      const qx = Math.abs(px - cx) - (hw - r);
      const qy = Math.abs(py - cy) - (hh - r);
      return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
    },
    bounds() {
      return [cx - hw - 1, cy - hh - 1, cx + hw + 1, cy + hh + 1];
    },
  };
}

function capsule(x1, y1, x2, y2, radius) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy || 1;
  return {
    distance(px, py) {
      const t = clamp(((px - x1) * dx + (py - y1) * dy) / len2, 0, 1);
      return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy)) - radius;
    },
    bounds() {
      const r = radius + 1;
      return [Math.min(x1, x2) - r, Math.min(y1, y2) - r, Math.max(x1, x2) + r, Math.max(y1, y2) + r];
    },
  };
}

function polygon(points, r) {
  const n = points.length;
  return {
    distance(px, py) {
      let min = Infinity;
      let inside = true;
      for (let i = 0; i < n; i++) {
        const [ax, ay] = points[i];
        const [bx, by] = points[(i + 1) % n];
        const ex = bx - ax;
        const ey = by - ay;
        const wx = px - ax;
        const wy = py - ay;
        const t = clamp((wx * ex + wy * ey) / (ex * ex + ey * ey || 1), 0, 1);
        min = Math.min(min, Math.hypot(wx - t * ex, wy - t * ey));
        if (ex * wy - ey * wx < 0) inside = false; // points run clockwise in screen space
      }
      return (inside ? -min : min) - r;
    },
    bounds() {
      const xs = points.map((p) => p[0]);
      const ys = points.map((p) => p[1]);
      return [Math.min(...xs) - r - 1, Math.min(...ys) - r - 1, Math.max(...xs) + r + 1, Math.max(...ys) + r + 1];
    },
  };
}

// ---------------------------------------------------------------- drawing

const dark = hexToRgb('#0b1621');
const accent = hexToRgb('#4cc2ff');
const accentSoft = hexToRgb('#7fd6ff');

// Background: rounded square with a soft vertical gradient.
const plate = roundRect(W / 2, W / 2, 236 * SS, 236 * SS, 96 * SS);
{
  const [x0, y0, x1, y1] = plate.bounds();
  for (let y = Math.max(0, y0); y <= Math.min(W - 1, y1); y++) {
    const t = y / W;
    const top = hexToRgb('#16222f');
    const bottom = hexToRgb('#0a1119');
    const color = [0, 1, 2].map((i) => Math.round(top[i] * (1 - t) + bottom[i] * t));
    for (let x = Math.max(0, x0); x <= Math.min(W - 1, x1); x++) {
      const coverage = clamp(0.5 - plate.distance(x + 0.5, y + 0.5), 0, 1);
      if (coverage > 0) blend(x, y, color, coverage);
    }
  }
}

// Inner hairline for a bit of depth.
paint(roundRect(W / 2, W / 2, 219 * SS, 219 * SS, 81 * SS), hexToRgb('#24384b'), 0.55);

// One big sheet of paper: the app is a place where a file docks.
const sheetW = 134 * SS;
const sheetH = 172 * SS;
const sheetR = 14 * SS;
const fold = 46 * SS;
const cx = W / 2;
const cy = W / 2 + 6 * SS;
const x0 = cx - sheetW;
const y0 = cy - sheetH;
const x1 = cx + sheetW;
const y1 = cy + sheetH;

const sheetPoints = [
  [x0, y0],
  [x1 - fold, y0],
  [x1, y0 + fold],
  [x1, y1],
  [x0, y1],
];

// Soft drop shadow so the sheet lifts off the plate.
paint(
  polygon(
    sheetPoints.map(([px, py]) => [px + 2 * SS, py + 12 * SS]),
    sheetR,
  ),
  hexToRgb('#02070c'),
  0.55,
);
const sheet = polygon(sheetPoints, sheetR);

// Sheet fill: light at the top, deeper at the bottom, like paper catching light.
{
  const [bx0, by0, bx1, by1] = sheet.bounds();
  const lit = hexToRgb('#6ed2ff');
  const deep = hexToRgb('#2fa4e6');
  for (let y = Math.max(0, by0); y <= Math.min(W - 1, by1); y++) {
    const t = clamp((y - y0) / (y1 - y0), 0, 1);
    const color = [0, 1, 2].map((i) => lit[i] * (1 - t) + deep[i] * t);
    for (let x = Math.max(0, bx0); x <= Math.min(W - 1, bx1); x++) {
      const coverage = clamp(0.5 - sheet.distance(x + 0.5, y + 0.5), 0, 1);
      if (coverage > 0) blend(x, y, color, coverage);
    }
  }
}

// Folded top-right corner, plus a hairline where the fold meets the page.
const flap = polygon(
  [
    [x1 - fold, y0],
    [x1, y0 + fold],
    [x1 - fold, y0 + fold],
  ],
  sheetR * 0.4,
);
paint(flap, hexToRgb('#1c74a6'), 1);
paint(capsule(x1 - fold, y0 + 2 * SS, x1 - 2 * SS, y0 + fold, 1.6 * SS), hexToRgb('#0e4a6b'), 0.85);

// Text lines on the sheet.
const insetX = x0 + 26 * SS;
const rightX = x1 - 26 * SS;
const widths = [0.42, 0.42, 0.3, 0.42, 0.22];
for (let i = 0; i < widths.length; i++) {
  const y = y0 + 84 * SS + i * 34 * SS;
  const w = (rightX - insetX) * widths[i];
  paint(capsule(insetX, y, insetX + w, y, 7 * SS), dark, 0.9);
}

// ---------------------------------------------------------------- output

const out = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const i = ((y * SS + sy) * W + (x * SS + sx)) * 4;
        const sa = pixels[i + 3];
        r += pixels[i] * sa;
        g += pixels[i + 1] * sa;
        b += pixels[i + 2] * sa;
        a += sa;
      }
    }
    const o = (y * SIZE + x) * 4;
    if (a > 0) {
      out[o] = Math.round(clamp(r / a, 0, 1) * 255);
      out[o + 1] = Math.round(clamp(g / a, 0, 1) * 255);
      out[o + 2] = Math.round(clamp(b / a, 0, 1) * 255);
    }
    out[o + 3] = Math.round((a / (SS * SS)) * 255);
  }
}

const crcTable = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c;
}
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  out.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

mkdirSync(join(root, 'build'), { recursive: true });
writeFileSync(join(root, 'build', 'icon.png'), png);
console.log(`icon written: build/icon.png (${SIZE}×${SIZE}, ${Math.round(png.length / 1024)} KB)`);
