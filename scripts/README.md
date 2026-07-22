# Demo recording harness

Regenerates the pitch video at [`docs/demo/ravenspire-demo.mp4`](../docs/demo/ravenspire-demo.mp4)
— a scripted Playwright walkthrough (raven vision → ops panel → Claude + Codex →
"needs you" → analytics) with narrated captions and highlight cues.

- `record-demo.cjs` — drives Chromium against `DEMO_BASE_URL` (default `http://127.0.0.1:3499`), records `.webm`, converts to `.mp4` via ffmpeg.
- `seed-demo.js` — posts **synthetic** sessions (fake heroes, projects, prompts) to that server, incl. one Codex hero and a world-boss-scale party. No real data.
- `gen-history.js <dir>` — writes a synthetic `history.csv` + `responses.jsonl` so the History charts and response analytics look alive.

## Prereqs

```bash
npm i -D playwright && npx playwright install chromium   # ffmpeg also on PATH for the .mp4
```

## Reproduce (against a throwaway server — never your live board)

The recorder makes real HTTP calls that write session state, so run it against an
**isolated** copy of the app on port 3499, not your live server on 3456:

```bash
# 1. isolated copy so demo data never touches your real sessions.json/history
tmp=$(mktemp -d)
cp *.js *.html *.webmanifest *.svg "$tmp"/
printf '{ "port":3499, "watchDesktop":false, "notify":{"toast":false} }' > "$tmp/config.json"
( cd "$tmp" && PORT=3499 NODE_PATH="$PWD/node_modules" node server.js ) &

# 2. seed synthetic sessions + history
node scripts/seed-demo.js
node scripts/gen-history.js "$tmp"

# 3. record (writes docs/demo/ravenspire-demo.mp4)
npm run demo:record

# 4. stop the throwaway server
curl -X POST http://127.0.0.1:3499/restart
```

Then **verify** the result — `ffprobe` for duration and extract a frame per scene
to eyeball captions/screens before shipping:

```bash
ffprobe -v error -show_entries format=duration -of csv=p=0 docs/demo/ravenspire-demo.mp4
ffmpeg -y -ss 20 -i docs/demo/ravenspire-demo.mp4 -frames:v 1 frame_20.png
```

The `.mp4` is committed (shareable on GitHub); the `.webm` and `scripts/tx/`
transcripts are gitignored (regenerable).
