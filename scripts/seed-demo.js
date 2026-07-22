#!/usr/bin/env node
// seed-demo.js — seed a throwaway Ravenspire server (PORT 3499) with SYNTHETIC
// sessions so we can capture clean, privacy-safe README screenshots. All names,
// paths, prompts and token counts are fake. Writes Claude-format transcripts so
// heroes reach real levels / gear tiers / a world boss.

const fs = require('fs');
const path = require('path');
const http = require('http');

const SERVER = 'http://127.0.0.1:3499';
const TX = path.join(__dirname, 'tx');
fs.mkdirSync(TX, { recursive: true });

function post(body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = http.request(SERVER + '/event', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => { res.on('data', () => {}); res.on('end', resolve); });
    req.on('error', resolve);
    req.write(data); req.end();
  });
}

// Write a Claude-format transcript summing to ~totalTokens, spread over ~45 min.
function writeTranscript(file, { model, prompt, lastMsg, totalTokens }) {
  const out = [];
  const base = Date.now() - 46 * 60 * 1000;
  const step = 3 * 60 * 1000;
  let t = base;
  const line = (o) => out.push(JSON.stringify({ ...o, timestamp: new Date(t).toISOString() }));
  line({ type: 'user', message: { role: 'user', content: prompt } });
  // split usage across 3 assistant messages
  const chunks = 3;
  const out_ = Math.round(totalTokens * 0.03);
  const inp = Math.round(totalTokens * 0.05);
  const cc = Math.round(totalTokens * 0.02);
  const cr = totalTokens - out_ - inp - cc;
  const filler = ['Digging into the code now.', 'Making the change and checking the tests.', 'Tidying up the edge cases.'];
  for (let i = 0; i < chunks; i++) {
    t += step;
    const last = i === chunks - 1;
    line({
      type: 'assistant',
      message: {
        role: 'assistant', id: `m${i}`, model,
        content: [{ type: 'text', text: last ? lastMsg : filler[i] }],
        usage: {
          input_tokens: Math.round(inp / chunks),
          output_tokens: Math.round(out_ / chunks),
          cache_creation_input_tokens: Math.round(cc / chunks),
          cache_read_input_tokens: Math.round(cr / chunks),
        },
      },
    });
  }
  fs.writeFileSync(file, out.map((l) => l).join('\n') + '\n');
  return file;
}

const HOST = 'GUILDHALL';
// Party of 3 sharing one workspace → shared monster, world-boss-scale tokens.
const PARTY = 'C:/guild/dragonforge-api';
const cast = [
  { id: 'demo-aurelia', model: 'claude-opus-4-8', ide: 'vscode', cwd: PARTY, title: 'dragonforge-api', tokens: 152_000_000, tool: 'Edit', target: 'oauth/exchange.rs',
    prompt: 'Harden the OAuth token exchange and add refresh-token rotation', last: 'Rotation is wired in; running the security tests now.' },
  { id: 'demo-borin', model: 'claude-sonnet-5', ide: 'vscode', cwd: PARTY, title: 'dragonforge-api', tokens: 61_000_000, tool: 'Bash', target: 'cargo test --all',
    prompt: 'Get the integration test suite green on CI', last: 'Two flaky tests left — stabilizing the fixtures.' },
  { id: 'demo-cade', model: 'claude-opus-4-8', ide: 'cli', cwd: PARTY, title: 'dragonforge-api', tokens: 33_000_000, tool: 'Read', target: 'schema/billing.sql',
    prompt: 'Design the billing schema migration', last: 'Drafting the migration with a backfill step.' },
  // Solo hero waiting on you (the alert banner + question preview)
  { id: 'demo-lyra', model: 'claude-sonnet-5', ide: 'vscode', cwd: 'C:/guild/frostwind-web', title: 'frostwind-web', tokens: 12_500_000, tool: 'Edit', target: 'checkout.tsx',
    prompt: 'Ship the new checkout flow', last: 'I can use a queue (BullMQ) for retries or a simple cron. Which do you want for the nightly export?', waiting: true },
  // Solo working hero
  { id: 'demo-pike', model: 'claude-haiku-4-5', ide: 'cli', cwd: 'C:/guild/emberforge-cli', title: 'emberforge-cli', tokens: 6_200_000, tool: 'Grep', target: 'deprecated api',
    prompt: 'Find and replace deprecated API calls repo-wide', last: 'Found 14 call sites; updating them in batches.' },
  // Codex hero — no transcript (tokens/cost stay 0), shows ✳️ codex + quest
  { id: 'demo-vesper', model: 'gpt-5.6-sol', ide: 'vscode', cwd: 'C:/guild/stormkeep-mobile', title: 'stormkeep-mobile', source: 'codex', tool: 'Edit', target: 'PushScreen.tsx',
    prompt: 'Wire up the push-notification screen' },
];

(async () => {
  for (const c of cast) {
    let transcriptPath = '';
    if (c.source !== 'codex') {
      transcriptPath = writeTranscript(path.join(TX, c.id + '.jsonl'), { model: c.model, prompt: c.prompt, lastMsg: c.last, totalTokens: c.tokens });
    }
    const common = { source: c.source || 'code', sessionId: c.id, cwd: c.cwd, title: c.title, ide: c.ide, host: HOST };
    await post({ type: 'SessionStart', hookEvent: 'SessionStart', transcriptPath, ...common, ...(c.source === 'codex' ? { model: c.model } : {}) });
    if (c.source === 'codex') await post({ type: 'UserPromptSubmit', hookEvent: 'UserPromptSubmit', prompt: c.prompt, ...common });
    await post({ type: 'PreToolUse', hookEvent: 'PreToolUse', tool: c.tool, target: c.target, ...common });
    await post({ type: 'PreToolUse', hookEvent: 'PreToolUse', tool: c.tool, target: c.target, ...common });
    if (c.waiting) await post({ type: 'Notification', hookEvent: 'Notification', message: 'Waiting for your decision', ...common });
    process.stdout.write(`seeded ${c.id}\n`);
  }
  console.log('done seeding');
})();
