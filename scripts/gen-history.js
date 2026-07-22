#!/usr/bin/env node
// gen-history.js <demoDir> — write synthetic history.csv + responses.jsonl so the
// History view's trend charts and response analytics look alive. All fake.
const fs = require('fs');
const path = require('path');
const dir = process.argv[2];
if (!dir) { console.error('need demoDir'); process.exit(1); }

// --- history.csv: ~50 snapshots over the last 6 hours, smooth growth ---
const HEADER = 'timestamp,sessions,active,waiting,tokens,api_cost_usd,labor_cost_usd\n';
const N = 50;
const now = Date.now();
const span = 6 * 60 * 60 * 1000;
const rows = [HEADER];
for (let i = 0; i < N; i++) {
  const f = i / (N - 1);
  const ease = Math.pow(f, 1.25);                 // accelerating growth
  const ts = new Date(now - span + f * span).toISOString();
  const sessions = Math.max(1, Math.round(1 + f * 5));            // 1 → 6
  const active = Math.max(1, Math.round(2 + Math.sin(i / 3) * 2 + f * 2)); // wobble 1–5
  const waiting = (i % 7 === 0 || i % 11 === 0) ? 1 : 0;          // occasional spikes
  const tokens = Math.round(ease * 264_700_000);
  const cost = (ease * 945.14).toFixed(4);
  const labor = (ease * 44.36).toFixed(2);
  rows.push([ts, sessions, active, waiting, tokens, cost, labor].join(',') + '\n');
}
fs.writeFileSync(path.join(dir, 'history.csv'), rows.join(''));

// --- responses.jsonl: ~14 resolved alerts across the last 7 days ---
const cast = [
  ['Nia', 'dragonforge-api'], ['Pax', 'dragonforge-api'], ['Cleo', 'dragonforge-api'],
  ['Bex', 'frostwind-web'], ['Yara', 'emberforge-cli'], ['Mira', 'stormkeep-mobile'],
];
const reasons = ['Finished — your turn', 'Needs your input', 'Approve: git push origin main', 'Approve: rm -rf build'];
const vias = ['reply', 'resumed', 'focus', 'reply', 'resumed'];
// waited durations chosen to spread across the buckets (<1m,1-5m,5-15m,15-60m,>1h)
const waits = [42_000, 8_000, 150_000, 240_000, 95_000, 600_000, 780_000, 1_500_000, 320_000, 55_000, 3_900_000, 130_000, 200_000, 70_000];
const lines = [];
for (let i = 0; i < waits.length; i++) {
  // spread respondedAt: half today, rest across the past week
  const daysAgo = i < 7 ? 0 : (i - 6);
  const respondedAt = new Date(now - daysAgo * 24 * 3600 * 1000 - (i % 5) * 37 * 60 * 1000).toISOString();
  const waitedMs = waits[i];
  const [name, project] = cast[i % cast.length];
  lines.push(JSON.stringify({
    sessionId: 'demo-' + name.toLowerCase(), name, project,
    reason: reasons[i % reasons.length],
    waitingSince: new Date(new Date(respondedAt).getTime() - waitedMs).toISOString(),
    respondedAt, waitedMs, via: vias[i % vias.length],
  }));
}
fs.writeFileSync(path.join(dir, 'responses.jsonl'), lines.join('\n') + '\n');
console.log(`wrote history.csv (${N} rows) + responses.jsonl (${waits.length} rows) to ${dir}`);
