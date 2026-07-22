// generate-icons.js — rasterize icon.svg into the PWA / favicon PNG set.
// icon.svg (the raven-on-the-spire beacon mark) is the single source of truth;
// this renders it headlessly at each size so the PNGs never drift from the SVG.
//
//   npm run icons
//
// Prereq: npm i -D playwright && npx playwright install chromium
//
// Outputs (repo root):
//   icon-192.png, icon-512.png       — rounded app icons (purpose "any")
//   icon-512-maskable.png            — full-bleed square (purpose "maskable")
//   apple-touch-icon.png (180)       — iOS home-screen icon
//   favicon-32.png                   — browser tab fallback

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const svg = fs.readFileSync(path.join(__dirname, 'icon.svg'), 'utf8');
// maskable needs full bleed (the platform applies its own mask), so square off
// the corners; the raven + beacon sit well inside the safe zone already.
const maskable = svg.replace('rx="112"', 'rx="0"');

const wrap = (s) =>
  `<!doctype html><meta charset="utf-8">` +
  `<style>*{margin:0;padding:0}html,body{width:100%;height:100%;background:transparent}` +
  `svg{display:block;width:100vw;height:100vh}</style>${s}`;

const targets = [
  ['icon-512.png', 512, svg],
  ['icon-192.png', 192, svg],
  ['apple-touch-icon.png', 180, svg],
  ['favicon-32.png', 32, svg],
  ['icon-512-maskable.png', 512, maskable],
];

(async () => {
  const browser = await chromium.launch();
  for (const [name, size, source] of targets) {
    const ctx = await browser.newContext({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await page.setContent(wrap(source), { waitUntil: 'load' });
    // omitBackground keeps the rounded-corner transparency on the "any" icons
    await page.screenshot({ path: path.join(__dirname, name), omitBackground: true });
    await ctx.close();
    console.log(`wrote ${name} (${size}px)`);
  }
  await browser.close();
  console.log('done.');
})().catch((err) => { console.error(err); process.exit(1); });
