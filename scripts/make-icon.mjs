// Generates build/icon.png — a blue rounded square with a white sigma.
// Pure Node: a tiny rasteriser plus a minimal PNG encoder, so no native deps.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const SIZE = 1024;
const SS = 2; // supersampling grid per axis
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(rgba, width, height) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => Math.min(1, Math.max(0, v));

function roundedRectInside(x, y, left, top, right, bottom, radius) {
  if (x < left || x > right || y < top || y > bottom) return false;
  const r = radius;
  if (x >= left + r && x <= right - r) return true;
  if (y >= top + r && y <= bottom - r) return true;
  const cx = x < left + r ? left + r : right - r;
  const cy = y < top + r ? top + r : bottom - r;
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

// Distance from p to segment ab.
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  let t = lengthSq ? ((px - ax) * dx + (py - ay) * dy) / lengthSq : 0;
  t = clamp01(t);
  const x = ax + t * dx;
  const y = ay + t * dy;
  return Math.hypot(px - x, py - y);
}

const sigma = [
  [0.74, 0.255],
  [0.295, 0.255],
  [0.525, 0.5],
  [0.295, 0.745],
  [0.74, 0.745],
];

function sigmaDistance(x, y) {
  let best = Infinity;
  for (let i = 0; i < sigma.length - 1; i += 1) {
    const [ax, ay] = sigma[i];
    const [bx, by] = sigma[i + 1];
    best = Math.min(best, segDist(x, y, ax, ay, bx, by));
  }
  return best;
}

const rgba = Buffer.alloc(SIZE * SIZE * 4);

for (let py = 0; py < SIZE; py += 1) {
  for (let px = 0; px < SIZE; px += 1) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;

    for (let sy = 0; sy < SS; sy += 1) {
      for (let sx = 0; sx < SS; sx += 1) {
        const x = (px + (sx + 0.5) / SS) / SIZE;
        const y = (py + (sy + 0.5) / SS) / SIZE;

        if (!roundedRectInside(x, y, 0.02, 0.02, 0.98, 0.98, 0.215)) continue;

        // Diagonal blue gradient + a soft top-left highlight.
        const t = clamp01((x + y) / 2);
        let cr = lerp(59, 29, t);
        let cg = lerp(130, 78, t);
        let cb = lerp(246, 216, t);
        const glow = Math.max(0, 1 - Math.hypot(x - 0.28, y - 0.22) / 0.75);
        cr = lerp(cr, 255, glow * 0.08);
        cg = lerp(cg, 255, glow * 0.08);
        cb = lerp(cb, 255, glow * 0.08);

        if (sigmaDistance(x, y) <= 0.055) {
          cr = 255;
          cg = 255;
          cb = 255;
        }

        r += cr;
        g += cg;
        b += cb;
        a += 255;
      }
    }

    const samples = SS * SS;
    const index = (py * SIZE + px) * 4;
    const coverage = a / (255 * samples);
    if (a === 0) {
      rgba[index + 3] = 0;
      continue;
    }
    rgba[index] = Math.round(r / (coverage * samples));
    rgba[index + 1] = Math.round(g / (coverage * samples));
    rgba[index + 2] = Math.round(b / (coverage * samples));
    rgba[index + 3] = Math.round(coverage * 255);
  }
}

fs.mkdirSync(path.join(root, 'build'), { recursive: true });
const output = path.join(root, 'build', 'icon.png');
fs.writeFileSync(output, encodePng(rgba, SIZE, SIZE));
console.log(`[icon] ${path.relative(root, output)} (${SIZE}×${SIZE})`);
