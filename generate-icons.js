// generate-icons.js — produces Ravenspire app icons (PNG) from a single procedural
// design so the PWA / favicon assets are reproducible. Run: node generate-icons.js
//
// Outputs (in repo root):
//   icon-192.png, icon-512.png       — rounded app icons (purpose "any")
//   icon-512-maskable.png            — full-bleed, safe-zone padded (purpose "maskable")
//   apple-touch-icon.png (180)       — iOS home-screen icon
//   favicon-32.png                   — browser tab fallback
//
// No external deps: PNG is encoded here with Node's built-in zlib.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// --------------------------------------------------------------------------
// Minimal PNG encoder (8-bit RGBA, single IDAT).
// --------------------------------------------------------------------------
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(size, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit, RGBA
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: none
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * stride + 1);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// --------------------------------------------------------------------------
// Procedural icon: a dark spire with lit windows (agents at work) and a
// glowing signal beacon on top. Rendered at 4x supersample then box-averaged.
// --------------------------------------------------------------------------
const SS = 4;

// palette
const BG_TOP = [35, 44, 82];      // #232c52
const BG_BOT = [18, 19, 40];      // #121328
const FACADE = [47, 62, 107];     // #2f3e6b
const HIGHLIGHT = [64, 84, 148];
const SHADOW = [31, 42, 78];
const WIN_BLUE = [91, 140, 255];  // #5b8cff
const WIN_GOLD = [255, 190, 74];  // #ffbe4a
const WIN_OFF = [24, 30, 56];
const DOOR = [120, 150, 220];
const BEACON = [255, 205, 90];

// which windows are lit (5 rows x 3 cols); 'b' blue, 'g' gold, '.' off
const WINDOWS = [
  ['b', '.', 'b'],
  ['g', 'b', 'b'],
  ['b', 'b', '.'],
  ['b', 'g', 'b'],
];

function lerp(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }

function render(size, maskable) {
  const W = size * SS;
  const buf = new Float32Array(W * W * 3); // opaque RGB
  const contentScale = maskable ? 0.78 : 1;   // maskable safe zone
  const cs = (f) => 0.5 + (f - 0.5) * contentScale; // scale fraction toward center

  // background gradient (full bleed)
  for (let y = 0; y < W; y++) {
    const c = lerp(BG_TOP, BG_BOT, y / (W - 1));
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2];
    }
  }

  const mix = (x, y, col, cov) => {
    if (x < 0 || y < 0 || x >= W || y >= W || cov <= 0) return;
    const i = (y * W + x) * 3, k = cov > 1 ? 1 : cov;
    buf[i] = buf[i] * (1 - k) + col[0] * k;
    buf[i + 1] = buf[i + 1] * (1 - k) + col[1] * k;
    buf[i + 2] = buf[i + 2] * (1 - k) + col[2] * k;
  };
  const rect = (fx0, fy0, fx1, fy1, col) => {
    const x0 = Math.round(cs(fx0) * W), x1 = Math.round(cs(fx1) * W);
    const y0 = Math.round(cs(fy0) * W), y1 = Math.round(cs(fy1) * W);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) mix(x, y, col, 1);
  };
  const disc = (fcx, fcy, fr, col, softness = 0) => {
    const cx = cs(fcx) * W, cy = cs(fcy) * W, r = fr * W * contentScale;
    const x0 = Math.floor(cx - r - softness * W), x1 = Math.ceil(cx + r + softness * W);
    const y0 = Math.floor(cy - r - softness * W), y1 = Math.ceil(cy + r + softness * W);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      let cov;
      if (softness > 0) cov = 1 - Math.min(1, Math.max(0, (d - r) / (softness * W)));
      else cov = Math.min(1, Math.max(0, r + 0.5 - d));
      mix(x, y, col, cov);
    }
  };

  // tower body
  const TX0 = 0.29, TX1 = 0.71, TY0 = 0.28, TY1 = 0.85;
  rect(TX0, TY0, TX1, TY1, FACADE);
  rect(TX0, TY0, TX0 + 0.035, TY1, HIGHLIGHT);  // left highlight
  rect(TX1 - 0.035, TY0, TX1, TY1, SHADOW);     // right shadow
  rect(TX0, TY0, TX1, TY0 + 0.025, HIGHLIGHT);  // roof cap

  // signal beacon: mast + glow
  rect(0.495, 0.17, 0.505, TY0, HIGHLIGHT);
  disc(0.5, 0.165, 0.075, [255, 205, 90], 0.06); // soft glow
  disc(0.5, 0.165, 0.028, BEACON);

  // windows grid inside tower
  const gx0 = TX0 + 0.06, gx1 = TX1 - 0.06, gy0 = TY0 + 0.07, gy1 = TY1 - 0.14;
  const cols = 3, rows = WINDOWS.length;
  const cw = (gx1 - gx0) / cols, ch = (gy1 - gy0) / rows;
  const wgap = cw * 0.28, hgap = ch * 0.30;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const kind = WINDOWS[r][c];
    const col = kind === 'b' ? WIN_BLUE : kind === 'g' ? WIN_GOLD : WIN_OFF;
    const wx0 = gx0 + c * cw + wgap / 2, wx1 = gx0 + (c + 1) * cw - wgap / 2;
    const wy0 = gy0 + r * ch + hgap / 2, wy1 = gy0 + (r + 1) * ch - hgap / 2;
    rect(wx0, wy0, wx1, wy1, col);
  }

  // doorway (center, base)
  rect(0.455, TY1 - 0.11, 0.545, TY1, DOOR);
  rect(0.478, TY1 - 0.11, 0.522, TY1, lerp(DOOR, BG_BOT, 0.3));

  // downsample SSxSS -> size, applying rounded-corner alpha mask
  const out = new Uint8Array(size * size * 4);
  const R = maskable ? 0 : size * 0.22; // rounded corners for "any", square for maskable
  const hs = size / 2;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const i = ((y * SS + sy) * W + (x * SS + sx)) * 3;
      r += buf[i]; g += buf[i + 1]; b += buf[i + 2];
    }
    const n = SS * SS;
    let alpha = 255;
    if (R > 0) {
      const qx = Math.abs(x + 0.5 - hs) - (hs - R);
      const qy = Math.abs(y + 0.5 - hs) - (hs - R);
      const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - R;
      alpha = Math.round(Math.min(1, Math.max(0, 0.5 - d)) * 255);
    }
    const o = (y * size + x) * 4;
    out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n); out[o + 2] = Math.round(b / n); out[o + 3] = alpha;
  }
  return encodePNG(size, out);
}

const outDir = __dirname;
const writes = [
  ['icon-192.png', render(192, false)],
  ['icon-512.png', render(512, false)],
  ['icon-512-maskable.png', render(512, true)],
  ['apple-touch-icon.png', render(180, false)],
  ['favicon-32.png', render(32, false)],
];
for (const [name, data] of writes) {
  fs.writeFileSync(path.join(outDir, name), data);
  console.log(`wrote ${name} (${data.length} bytes)`);
}
console.log('done.');
