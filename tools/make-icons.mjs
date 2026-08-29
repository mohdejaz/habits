// Generates the app icons as PNGs — a budget gauge ring on a rounded square.
// Drawn by hand into a pixel buffer so the project needs no image toolchain.

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const SS = 3; // supersampling factor, for smooth edges

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

// Signed coverage of a rounded rectangle, in 0..1.
function roundedRect(x, y, w, h, r) {
  const dx = Math.max(r - x, 0, x - (w - r));
  const dy = Math.max(r - y, 0, y - (h - r));
  if (dx <= 0 || dy <= 0) return x >= 0 && x <= w && y >= 0 && y <= h;
  return Math.hypot(dx, dy) <= r;
}

function drawIcon(size, { padding = 0 } = {}) {
  const S = size * SS;
  const pad = padding * SS;
  const inner = S - pad * 2;
  const rgba = Buffer.alloc(size * size * 4);

  const top = [0x6f, 0x9c, 0xf5];
  const bottom = [0x3f, 0x6a, 0xd8];
  const cx = S / 2;
  const cy = S / 2;
  const ringOuter = inner * 0.33;
  const ringInner = ringOuter - inner * 0.105;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = px * SS + sx + 0.5;
          const y = py * SS + sy + 0.5;
          if (!roundedRect(x - pad, y - pad, inner, inner, inner * 0.235)) continue;

          let color = mix(top, bottom, (y - pad) / inner);

          // The gauge: a ring with a wedge cut out, reading as "budget left".
          const dist = Math.hypot(x - cx, y - cy);
          if (dist <= ringOuter && dist >= ringInner) {
            // 0 at 12 o'clock, growing clockwise.
            let angle = (Math.atan2(x - cx, cy - y) * 180) / Math.PI;
            if (angle < 0) angle += 360;
            if (angle <= 265) color = [0xff, 0xff, 0xff];
          }
          r += color[0]; g += color[1]; b += color[2]; a += 255;
        }
      }

      const n = SS * SS;
      const i = (py * size + px) * 4;
      const cover = a / (n * 255);
      if (cover > 0) {
        rgba[i] = Math.round(r / (a / 255));
        rgba[i + 1] = Math.round(g / (a / 255));
        rgba[i + 2] = Math.round(b / (a / 255));
      }
      rgba[i + 3] = Math.round(cover * 255);
    }
  }
  return rgba;
}

/* ---------- minimal PNG writer ---------- */

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function png(rgba, size) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const targets = [
  ['public/icons/icon-192.png', 192, {}],
  ['public/icons/icon-512.png', 512, {}],
  ['public/icons/icon-180.png', 180, {}],
  ['public/icons/maskable-512.png', 512, { padding: 64 }], // keeps art inside the safe zone
];

for (const [path, size, opts] of targets) {
  writeFileSync(path, png(drawIcon(size, opts), size));
  console.log('wrote', path, size);
}
