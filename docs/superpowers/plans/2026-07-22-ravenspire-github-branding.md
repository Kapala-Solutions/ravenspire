# Ravenspire GitHub Branding & Donations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the GitHub-page branding (§4) and donations (§5) of the approved Ravenspire rebrand spec — the mechanical rename (§1–§3) already landed in commit `4accaa0`.

**Architecture:** A single zero-dependency Node script procedurally generates the brand assets (README hero banner as pixel-art SVG, 1280×640 social-preview PNG) from shared pixel maps, reusing the repo's existing hand-rolled PNG encoder (extracted from `generate-icons.js` into a shared module). The README gets a re-led header (banner → tagline → badges) and a Support section; `.github/FUNDING.yml` enables GitHub's Sponsor button.

**Tech Stack:** Plain Node 18+ (CommonJS), built-in `zlib` for PNG encoding, hand-authored SVG. No new dependencies — the repo's whole pitch is "zero build, one dependency (`ws`)".

## Global Constraints

- **No new npm dependencies.** Runtime deps stay exactly `ws` (spec §3 / repo ethos).
- **Node ≥ 18**, CommonJS (`"type": "commonjs"` in package.json).
- **Donation placeholder:** the literal string `KOFI_USERNAME_PLACEHOLDER` must be used for the Ko-fi username in exactly two files (`README.md`, `.github/FUNDING.yml`) so one find-and-replace swaps it (spec §5).
- **Palette (spec §4):** midnight navy `#0b0e1a`, raven black `#14161f`, moonlit silver `#c8d0e0`, arcane violet `#8b7cf6`, ember `#e8a33d`; tower colors reuse the icon palette from `generate-icons.js` (`#2f3e6b` facade, `#405494` highlight, `#1f2a4e` shadow, `#ffbe4a` gold windows, `#5b8cff` blue windows).
- **Copy (spec §2):** one-liner *"Mission control for your AI agents — as a JRPG."*; tagline *"When an agent needs you, a raven flies."*
- Do not rename `aihq-*` localStorage keys, the `app: 'ai-hq'` webhook identifier, `start-aihq.vbs`, or the `ai-hq-server` launch-config name — commit `4accaa0` deliberately kept these for backward compatibility.
- Windows environment; run commands from the repo root `C:\Users\Vinicius.Ribeiro.000\sources\repos\ai-hq` on branch `feat/ravenspire-rebrand`.

---

### Task 1: Extract the PNG encoder into a shared `png.js` module

`generate-icons.js` contains a square-only PNG encoder (`encodePNG(size, rgba)`). The social-preview image is 1280×640, so the encoder must support width ≠ height. Extract and generalize it; `generate-icons.js` keeps working unchanged (byte-identical icons).

**Files:**
- Create: `png.js` (repo root)
- Modify: `generate-icons.js:16-52` (remove CRC/chunk/encodePNG block, require the module) and `generate-icons.js:172` (call site)

**Interfaces:**
- Produces: `module.exports = { encodePNG }` where `encodePNG(width, height, rgba)` takes a `Uint8Array` of `width*height*4` RGBA bytes and returns a PNG `Buffer`. Task 2 consumes this exact signature via `require('../../png')`.

- [ ] **Step 1: Create `png.js` with the generalized encoder**

```js
// png.js — minimal zero-dependency PNG encoder (8-bit RGBA, single IDAT).
// Shared by generate-icons.js (square app icons) and docs/brand/generate-brand.js
// (non-square banner/social images). No external deps: zlib does the deflate.

const zlib = require('zlib');

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

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit, RGBA
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * stride + 1);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

module.exports = { encodePNG };
```

- [ ] **Step 2: Point `generate-icons.js` at the module**

Delete lines 16–52 of `generate-icons.js` (the comment banner `// Minimal PNG encoder…` through the closing brace of `encodePNG`, including the `const zlib = require('zlib');` line which nothing else uses) and add the require below the other requires:

```js
const { encodePNG } = require('./png');
```

Change the single call site (old line 172):

```js
  return encodePNG(size, size, out);
```

- [ ] **Step 3: Regression-check — icons must be byte-identical**

Run: `node generate-icons.js && git status --short`
Expected: five `wrote …` lines then `done.`; `git status` shows **only** `generate-icons.js` and `png.js` as changed/new — no `*.png` modifications (identical bytes ⇒ git sees no change).

- [ ] **Step 4: Commit**

```bash
git add png.js generate-icons.js
git commit -m "Extract PNG encoder into shared png.js (width/height support)"
```

---

### Task 2: Procedural brand assets — banner SVG + social PNG

One script draws a pixel-art scene (night sky, moon, stars, the spire from the icon motif, a raven perched on top, "RAVENSPIRE" wordmark in a 5×7 pixel font) onto a cell grid, then emits it twice: the README banner as crisp-edges SVG (640×160 cells at 4:1) and the social preview as 1280×640 PNG (2:1, taller composition).

**Files:**
- Create: `docs/brand/generate-brand.js`
- Create (generated, committed): `docs/brand/ravenspire-banner.svg`, `docs/brand/ravenspire-social.png`
- Modify: `package.json:6-10` (add `"brand"` script)

**Interfaces:**
- Consumes: `encodePNG(width, height, rgba)` from Task 1 via `require('../../png')`.
- Produces: `docs/brand/ravenspire-banner.svg` — referenced by README in Task 3 as `docs/brand/ravenspire-banner.svg`.

- [ ] **Step 1: Write `docs/brand/generate-brand.js`**

```js
// docs/brand/generate-brand.js — procedurally generates the Ravenspire brand
// assets from shared pixel maps. Run: npm run brand  (or node docs/brand/generate-brand.js)
//
// Outputs (in docs/brand/):
//   ravenspire-banner.svg   — README hero banner (1280×320 viewBox, pixel-art rects)
//   ravenspire-social.png   — GitHub social preview (1280×640)
//
// Zero deps: SVG is emitted as merged <rect> runs; PNG uses ../../png.js.

const fs = require('fs');
const path = require('path');
const { encodePNG } = require('../../png');

// ---- palette (spec §4 + icon palette from generate-icons.js) -------------
const C = {
  skyTop: '#0b0e1a', skyMid: '#10142a', skyLow: '#141b36',
  star: '#c8d0e0', starDim: '#4a5273',
  moon: '#e8ecf5', moonShade: '#c2c9dd',
  raven: '#14161f', ravenEye: '#8b7cf6',
  tower: '#2f3e6b', towerHi: '#405494', towerSh: '#1f2a4e',
  winGold: '#ffbe4a', winBlue: '#5b8cff',
  word: '#c8d0e0', wordShadow: '#3a4160',
};

// ---- 5×7 pixel font (only the glyphs the wordmark needs) -----------------
const FONT = {
  R: ['XXXX.', 'X...X', 'X...X', 'XXXX.', 'X.X..', 'X..X.', 'X...X'],
  A: ['.XXX.', 'X...X', 'X...X', 'XXXXX', 'X...X', 'X...X', 'X...X'],
  V: ['X...X', 'X...X', 'X...X', 'X...X', 'X...X', '.X.X.', '..X..'],
  E: ['XXXXX', 'X....', 'X....', 'XXXX.', 'X....', 'X....', 'XXXXX'],
  N: ['X...X', 'XX..X', 'X.X.X', 'X..XX', 'X...X', 'X...X', 'X...X'],
  S: ['.XXXX', 'X....', 'X....', '.XXX.', '....X', '....X', 'XXXX.'],
  P: ['XXXX.', 'X...X', 'X...X', 'XXXX.', 'X....', 'X....', 'X....'],
  I: ['XXXXX', '..X..', '..X..', '..X..', '..X..', '..X..', 'XXXXX'],
};

// ---- perched raven, 12 wide × 12 tall, facing left ('e' = violet eye) ----
const RAVEN = [
  '....XXX.....',
  '...XXXXX....',
  '..XeXXXXX...',
  'XXXXXXXXX...',
  '...XXXXXXX..',
  '...XXXXXXXX.',
  '...XXXXXXXX.',
  '....XXXXXXX.',
  '.....XXXXX..',
  '......XXX...',
  '......X.X...',
  '.....XX.XX..',
];

// ---- grid helpers ---------------------------------------------------------
const makeGrid = (w, h, fill) => Array.from({ length: h }, () => Array(w).fill(fill));
const px = (g, x, y, c) => { if (y >= 0 && y < g.length && x >= 0 && x < g[0].length) g[y][x] = c; };
const rect = (g, x0, y0, x1, y1, c) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) px(g, x, y, c); };
const disc = (g, cx, cy, r, c) => {
  for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++)
    if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) px(g, x, y, c);
};
const sprite = (g, x0, y0, rows, map) => rows.forEach((row, dy) =>
  [...row].forEach((ch, dx) => { if (map[ch]) px(g, x0 + dx, y0 + dy, map[ch]); }));

function drawText(g, x0, y0, s, scale, color, shadow) {
  const put = (ox, oy, c) => { let x = x0 + ox; for (const ch of s) {
    FONT[ch].forEach((row, gy) => [...row].forEach((cc, gx) => {
      if (cc === 'X') rect(g, x + gx * scale, y0 + oy + gy * scale, x + (gx + 1) * scale, y0 + oy + (gy + 1) * scale, c);
    }));
    x += 6 * scale; // 5 glyph cols + 1 col tracking
  } };
  if (shadow) put(1, 1, shadow);
  put(0, 0, color);
}
const textWidth = (s, scale) => s.length * 6 * scale - scale;

// ---- shared scene pieces ---------------------------------------------------
function drawSky(g, bands) { // bands: [[untilRow, color], ...]
  let from = 0;
  for (const [until, c] of bands) { rect(g, 0, from, g[0].length, until, c); from = until; }
}
function drawStars(g, coords) {
  coords.forEach(([x, y, dim]) => px(g, x, y, dim ? C.starDim : C.star));
}
function drawSpire(g, x0, top, bottom) { // 12 cells wide, raven perched on top
  const x1 = x0 + 12;
  rect(g, x0, top, x1, bottom, C.tower);
  rect(g, x0, top, x0 + 1, bottom, C.towerHi);            // left highlight
  rect(g, x1 - 1, top, x1, bottom, C.towerSh);            // right shadow
  for (let x = x0; x < x1; x += 2) px(g, x, top - 1, C.tower); // battlements
  // windows: rows of gold/blue "agents at work" lights
  const pattern = ['g', 'b', 'b', 'g', 'b'];
  for (let r = 0; r < 5; r++) {
    const wy = top + 3 + r * 4;
    if (wy + 2 > bottom - 4) break;
    [x0 + 2, x0 + 5, x0 + 8].forEach((wx, i) => {
      const kind = pattern[(r + i) % pattern.length];
      rect(g, wx, wy, wx + 2, wy + 2, kind === 'g' ? C.winGold : C.winBlue);
    });
  }
  rect(g, x0 + 4, bottom - 4, x0 + 8, bottom, C.towerSh); // doorway
  sprite(g, x0, top - 13, RAVEN, { X: C.raven, e: C.ravenEye }); // the raven
}

// ---- compositions ----------------------------------------------------------
function bannerGrid() { // 160×40 cells → 1280×320 @ 8px
  const g = makeGrid(160, 40, C.skyTop);
  drawSky(g, [[14, C.skyTop], [28, C.skyMid], [40, C.skyLow]]);
  drawStars(g, [[6, 4], [11, 9, 1], [34, 3], [47, 7, 1], [58, 2], [69, 6], [83, 4, 1],
    [96, 8], [104, 3], [118, 6, 1], [126, 2], [150, 5, 1], [155, 12], [40, 12, 1], [72, 11, 1]]);
  disc(g, 141, 8, 5, C.moon);
  px(g, 139, 6, C.moonShade); px(g, 142, 9, C.moonShade); px(g, 140, 10, C.moonShade);
  drawSpire(g, 14, 16, 40);
  const s = 'RAVENSPIRE', scale = 2;
  drawText(g, 34 + Math.floor((122 - textWidth(s, scale)) / 2), 16, s, scale, C.word, C.wordShadow);
  return g;
}

function socialGrid() { // 160×80 cells → 1280×640 @ 8px
  const g = makeGrid(160, 80, C.skyTop);
  drawSky(g, [[30, C.skyTop], [56, C.skyMid], [80, C.skyLow]]);
  drawStars(g, [[8, 6], [19, 14, 1], [30, 4], [43, 10], [55, 5, 1], [66, 16], [77, 3],
    [90, 9, 1], [101, 18], [113, 6], [124, 12, 1], [136, 4], [148, 15], [152, 7, 1],
    [24, 24, 1], [60, 26], [98, 27, 1], [140, 25, 1], [12, 34, 1], [150, 38, 1]]);
  disc(g, 148, 10, 6, C.moon);
  px(g, 145, 8, C.moonShade); px(g, 150, 12, C.moonShade); px(g, 147, 13, C.moonShade);
  const s = 'RAVENSPIRE', scale = 2;
  drawText(g, Math.floor((160 - textWidth(s, scale)) / 2), 10, s, scale, C.word, C.wordShadow);
  drawSpire(g, 74, 42, 80);
  return g;
}

// ---- emitters --------------------------------------------------------------
function toSVG(g, cell) {
  const w = g[0].length * cell, h = g.length * cell;
  let out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges" role="img" aria-label="Ravenspire — a raven-topped spire keeping watch under the moon">`;
  for (let y = 0; y < g.length; y++) {
    let x = 0;
    while (x < g[0].length) {
      const c = g[y][x];
      let x1 = x; while (x1 < g[0].length && g[y][x1] === c) x1++;
      out += `<rect x="${x * cell}" y="${y * cell}" width="${(x1 - x) * cell}" height="${cell}" fill="${c}"/>`;
      x = x1;
    }
  }
  return out + '</svg>\n';
}

function toPNG(g, cell) {
  const w = g[0].length * cell, h = g.length * cell;
  const rgba = new Uint8Array(w * h * 4);
  const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, gr, b] = hex(g[(y / cell) | 0][(x / cell) | 0]);
    const o = (y * w + x) * 4;
    rgba[o] = r; rgba[o + 1] = gr; rgba[o + 2] = b; rgba[o + 3] = 255;
  }
  return encodePNG(w, h, rgba);
}

// ---- write -----------------------------------------------------------------
const outDir = __dirname;
fs.writeFileSync(path.join(outDir, 'ravenspire-banner.svg'), toSVG(bannerGrid(), 8));
console.log('wrote ravenspire-banner.svg');
fs.writeFileSync(path.join(outDir, 'ravenspire-social.png'), toPNG(socialGrid(), 8));
console.log('wrote ravenspire-social.png (1280x640)');
console.log('done.');
```

- [ ] **Step 2: Add the npm script**

In `package.json` `"scripts"`, after the `"icons"` entry add:

```json
    "brand": "node docs/brand/generate-brand.js"
```

- [ ] **Step 3: Run and sanity-check the outputs**

Run: `npm run brand`
Expected: `wrote ravenspire-banner.svg`, `wrote ravenspire-social.png (1280x640)`, `done.`

Run: `node -e "const fs=require('fs');const s=fs.readFileSync('docs/brand/ravenspire-banner.svg','utf8');const p=fs.readFileSync('docs/brand/ravenspire-social.png');console.log('svg ok:',s.startsWith('<svg')&&s.trimEnd().endsWith('</svg>'));console.log('png sig ok:',p[0]===137&&p[1]===80);console.log('png ihdr:',p.readUInt32BE(16),'x',p.readUInt32BE(20))"`
Expected: `svg ok: true`, `png sig ok: true`, `png ihdr: 1280 x 640`

- [ ] **Step 4: Visual check**

Open `docs/brand/ravenspire-banner.svg` and `docs/brand/ravenspire-social.png` in the browser preview. Verify: wordmark reads "RAVENSPIRE" cleanly, raven silhouette sits on the spire and reads as a bird (adjust the `RAVEN` pixel map if it doesn't — that's expected art iteration, keep edits inside the map), windows glow gold/blue, moon doesn't collide with the wordmark. Take a screenshot for the session record.

- [ ] **Step 5: Commit**

```bash
git add docs/brand/generate-brand.js docs/brand/ravenspire-banner.svg docs/brand/ravenspire-social.png package.json
git commit -m "Brand assets: procedural pixel-art banner SVG + social preview PNG"
```

---

### Task 3: README re-lead — banner, tagline, badges

**Files:**
- Modify: `README.md:1-9` (header block only; everything from `---` before `## Why` down is untouched by this task)

**Interfaces:**
- Consumes: `docs/brand/ravenspire-banner.svg` from Task 2; `KOFI_USERNAME_PLACEHOLDER` contract from Global Constraints.

- [ ] **Step 1: Replace the README header**

Replace lines 1–9 (from `# 🐦‍⬛ Ravenspire` through the `![Ravenspire — the quest world](ravenspire-rpg.png)` image line) with:

```markdown
<p align="center">
  <img src="docs/brand/ravenspire-banner.svg" alt="Ravenspire — a raven-topped spire keeping watch under the moon" width="100%">
</p>

<p align="center"><em>When an agent needs you, a raven flies.</em></p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-8b7cf6" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A518-e8a33d" alt="Node 18+">
  <img src="https://img.shields.io/badge/PRs-welcome-5b8cff" alt="PRs welcome">
  <a href="https://ko-fi.com/KOFI_USERNAME_PLACEHOLDER"><img src="https://img.shields.io/badge/%F0%9F%8D%BA_buy_me_a_beer-ffbe4a" alt="Buy me a beer"></a>
</p>

# 🐦‍⬛ Ravenspire

**Mission control for your AI agents — as a JRPG.**

Every Claude Code session on your machine becomes a pixel-art **hero** in a living guild world: their task is a **quest**, working means **battling a monster** sized by the job, tool calls land as **attacks in a live battle log**, and the biggest project spawns a **☠ WORLD BOSS**. Behind the game sits a full **control panel** with cost & labor analytics, response-time tracking, durable history, and native notifications.

Zero build. Zero frameworks. One `npm start`.

![Ravenspire — the quest world](ravenspire-rpg.png)
```

- [ ] **Step 2: Verify the markdown references resolve**

Run: `node -e "const fs=require('fs');const md=fs.readFileSync('README.md','utf8');for(const f of ['docs/brand/ravenspire-banner.svg','ravenspire-rpg.png','ravenspire-dashboard.png','ravenspire-history.png']){if(!md.includes(f))throw new Error('README missing ref: '+f);if(!fs.existsSync(f))throw new Error('file missing: '+f)};if((md.match(/KOFI_USERNAME_PLACEHOLDER/g)||[]).length!==1)throw new Error('expected exactly 1 placeholder in README header task');console.log('README refs ok')"`
Expected: `README refs ok`

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "README: hero banner, tagline, badge row"
```

---

### Task 4: Support section + FUNDING.yml

**Files:**
- Modify: `README.md` (insert Support section immediately above `## 📜 License & credits`)
- Create: `.github/FUNDING.yml`

**Interfaces:**
- Consumes: `KOFI_USERNAME_PLACEHOLDER` contract. After this task the placeholder appears exactly **twice in README.md** (badge + support button) **and once in FUNDING.yml**.

- [ ] **Step 1: Insert the Support section**

Immediately before the line `## 📜 License & credits` in `README.md`, insert:

```markdown
## 🍺 Support

Ravenspire is free and MIT-licensed — ravens, however, fly on beer money. If it saves you tokens or sanity:

<a href="https://ko-fi.com/KOFI_USERNAME_PLACEHOLDER"><img src="https://img.shields.io/badge/%F0%9F%8D%BA_Buy_me_a_beer-ffbe4a?style=for-the-badge" alt="Buy me a beer"></a>

```

- [ ] **Step 2: Create `.github/FUNDING.yml`**

```yaml
# GitHub "Sponsor" button → Ko-fi.
# LAUNCH CHECKLIST: replace KOFI_USERNAME_PLACEHOLDER with the real username
# (also twice in README.md) before any public announcement.
ko_fi: KOFI_USERNAME_PLACEHOLDER
```

- [ ] **Step 3: Verify placeholder count and YAML shape**

Run: `node -e "const fs=require('fs');const md=fs.readFileSync('README.md','utf8');const fy=fs.readFileSync('.github/FUNDING.yml','utf8');const n=(md.match(/KOFI_USERNAME_PLACEHOLDER/g)||[]).length;if(n!==2)throw new Error('README placeholders: '+n+' (want 2)');if(!/^ko_fi: KOFI_USERNAME_PLACEHOLDER$/m.test(fy))throw new Error('FUNDING.yml malformed');console.log('donations wiring ok')"`
Expected: `donations wiring ok`

- [ ] **Step 4: Commit**

```bash
git add README.md .github/FUNDING.yml
git commit -m "Donations: Buy me a beer button, Support section, FUNDING.yml"
```

---

### Task 5: Full verification sweep (spec success criteria)

**Files:**
- Modify: none expected (fix-forward if a check fails)

- [ ] **Step 1: Brand-string sweep**

Run: `git grep -li agentquest -- ':!docs/superpowers'`
Expected: empty output (exit 1). Runtime code, manifest, scripts, and README contain zero AgentQuest references; only the spec/plan docs under `docs/superpowers` may mention the old name.

- [ ] **Step 2: Smoke-run the server and check branding surfaces**

Note: port 3456 is probably already held by the owner's **live** Ravenspire instance running this same working tree — if `netstat -ano | findstr :3456` shows a listener, curl the live instance instead of starting a second server (restart it first if it predates the rebrand commit). Otherwise run `node server.js` in the background, then `curl -s http://127.0.0.1:3456/ | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const m=d.match(/<title>([^<]*)<\/title>/);console.log('title:',m&&m[1]);if(!/Ravenspire/i.test(m&&m[1]))process.exit(1)})"` and `curl -s http://127.0.0.1:3456/manifest.webmanifest | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.name, '/', j.short_name);if(!/Ravenspire/.test(j.name))process.exit(1)})"`
Expected: `title: …Ravenspire…` and a manifest name containing `Ravenspire`. Stop the server afterward.

- [ ] **Step 3: README render check + screenshot**

Open the repo README in the browser preview (served page or rendered file), verify the banner renders full-width with crisp pixels, badges line up, the Support section shows the beer button. Screenshot for the session record.

- [ ] **Step 4: Commit any fixes**

Only if steps 1–3 surfaced fixes:

```bash
git add -A
git commit -m "Branding verification fixes"
```

---

## Owner checklist (manual, not automatable — surface to the user at the end)

1. Create the Ko-fi account (~2 min, ko-fi.com) → replace `KOFI_USERNAME_PLACEHOLDER` in `README.md` (×2) and `.github/FUNDING.yml` (×1).
2. Rename the GitHub repo to `Kapala-Solutions/ravenspire` (Settings → General; old URLs redirect).
3. Repo Settings → General → Social preview → upload `docs/brand/ravenspire-social.png`.
4. Repo About: description *"Mission control for your AI agents, as a JRPG — when an agent needs you, a raven flies."*; topics `claude-code`, `codex`, `ai-agents`, `dashboard`, `monitoring`, `observability`, `pixel-art`, `jrpg`, `nodejs`, `pwa`.
5. Register `ravenspire.dev`; reserve the `ravenspire` npm name (both verified available 2026-07-22 — availability decays).
6. Merge `feat/ravenspire-rebrand` → `main`.
