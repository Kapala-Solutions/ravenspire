/**
 * record-demo.cjs — automated Ravenspire demo video (Playwright + Chromium).
 * Adapted from the recording-demo-videos skill template.
 *
 * Prereqs: a Ravenspire server running at DEMO_BASE_URL, seeded with demo
 * sessions. Output: docs/demo/ravenspire-demo.webm (+ .mp4 if ffmpeg on PATH).
 *
 * The demo drives a THROWAWAY server on :3499 seeded with synthetic sessions —
 * no real project data. See scripts/seed-demo.js + scripts/gen-history.js.
 *
 * Run: npm i -D playwright && npx playwright install chromium
 *      DEMO_BASE_URL=http://127.0.0.1:3499 node scripts/record-demo.cjs
 */
const { chromium } = require("playwright");
const { execFileSync } = require("node:child_process");
const { existsSync, mkdirSync, renameSync } = require("node:fs");
const { join, resolve } = require("node:path");

const BASE = process.env.DEMO_BASE_URL || "http://127.0.0.1:3499";
const OUT_DIR = resolve(__dirname, "..", "docs", "demo");
const VIEWPORT = { width: 1360, height: 820 };
// Ravenspire palette (from icon.svg): deep navy + beacon gold.
const BRAND = { bg: "#171a2e", accent: "#ffcd5a", fg: "#f2f7f0" };
const VIDEO_NAME = "ravenspire-demo";

async function caption(page, text, subtext = "") {
  await page.evaluate(
    ([t, s, brand]) => {
      let el = document.getElementById("demo-caption");
      if (!el) {
        el = document.createElement("div");
        el.id = "demo-caption";
        el.style.cssText = [
          "position:fixed", "left:50%", "bottom:26px", "transform:translateX(-50%)",
          "z-index:2147483647", `background:${brand.bg}f2`, `color:${brand.fg}`,
          "padding:15px 24px", "border-radius:12px",
          "font-family:ui-sans-serif,system-ui,sans-serif", "font-size:18px",
          "line-height:1.4", "max-width:900px", "text-align:center",
          "box-shadow:0 10px 34px rgba(0,0,0,.55)",
          `border-left:5px solid ${brand.accent}`,
          "pointer-events:none", "transition:opacity .3s",
        ].join(";");
        document.body.appendChild(el);
      }
      el.innerHTML =
        `<strong>${t}</strong>` +
        (s ? `<br><span style="font-size:14.5px;opacity:.85">${s}</span>` : "");
      el.style.opacity = "1";
    },
    [text, subtext, BRAND],
  );
}

async function highlight(locator) {
  try {
    await locator.first().evaluate((el, accent) => {
      const prev = el.style.boxShadow;
      el.style.boxShadow = `0 0 0 4px ${accent}e6`;
      el.style.borderRadius = el.style.borderRadius || "8px";
      setTimeout(() => { el.style.boxShadow = prev; }, 1400);
    }, BRAND.accent);
  } catch { /* cosmetic — never fails the recording */ }
  try { await locator.first().page().waitForTimeout(950); } catch {}
}

const pause = (page, ms) => page.waitForTimeout(ms);
// The app holds a live WebSocket, so `networkidle` never settles — use load + pause.
async function goto(page, path) {
  await page.goto(`${BASE}${path}`, { waitUntil: "load" });
  await page.waitForTimeout(1400); // let the WS snapshot render
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ slowMo: 110 });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    recordVideo: { dir: OUT_DIR, size: VIEWPORT },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  // ══ ACT 1 — THE VISION ══
  await goto(page, "/rpg");
  await page.keyboard.press("Enter").catch(() => {}); // dismiss splash if present
  await pause(page, 600);
  await caption(page, "🐦‍⬛ Ravenspire", "Mission control for your AI agents — as a JRPG.");
  await pause(page, 4200);
  await caption(page, "Every session becomes a hero", "Claude Code &amp; OpenAI Codex — quests, live battles, a world boss.");
  await pause(page, 5000);

  // ══ ACT 2 — HOW IT WORKS (the ops panel behind the game) ══
  await goto(page, "/dashboard");
  await caption(page, "Behind the game: a real ops panel", "Per session — model, tokens, API cost, and labor value.");
  await pause(page, 4200);
  await highlight(page.locator(".badge.source-codex"));
  await caption(page, "Claude and Codex, side by side", "Every session tagged &amp; badged — ✳️ codex, ⌨️ code.");
  await pause(page, 4200);

  // ══ ACT 3 — THE EXPERIENCE (it tells you when it needs you) ══
  await page.mouse.wheel(0, 780);
  await pause(page, 700);
  await highlight(page.getByText("THE AGENT SAYS"));
  await caption(page, "It tells you when an agent needs you", "Waiting cards surface the agent's actual question, with a timer.");
  await pause(page, 4600);

  // ══ ACT 4 — THE PROOF (durable history + analytics) ══
  await goto(page, "/history");
  await caption(page, "Durable history &amp; response analytics", "Trends over time, median response, and every wait measured.");
  await pause(page, 4600);

  // ── Close on the vision ──
  await goto(page, "/rpg");
  await page.keyboard.press("Enter").catch(() => {});
  await pause(page, 500);
  await caption(page, "🐦‍⬛ Ravenspire", "Make watching your agents something you actually want to do.");
  await pause(page, 4200);

  const video = page.video();
  await context.close();
  await browser.close();

  const rawPath = await video.path();
  const webm = join(OUT_DIR, `${VIDEO_NAME}.webm`);
  renameSync(rawPath, webm);
  console.log(`[demo] recorded: ${webm}`);

  try {
    const mp4 = join(OUT_DIR, `${VIDEO_NAME}.mp4`);
    execFileSync("ffmpeg", ["-y", "-i", webm, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "22", mp4], { stdio: "ignore" });
    if (existsSync(mp4)) console.log(`[demo] converted: ${mp4}`);
  } catch {
    console.log("[demo] no ffmpeg — kept .webm");
  }
  console.log("[demo] NOW VERIFY: ffprobe duration + extract a frame per scene and inspect.");
}

main().catch((err) => { console.error("[demo] recording failed:", err); process.exitCode = 1; });
