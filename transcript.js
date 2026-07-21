// transcript.js — pure helper to extract token usage, model, and a name hint
// from a Claude Code transcript .jsonl file.
//
// The transcript is newline-delimited JSON. Assistant messages carry a
// `message.usage` object with token counts and a `message.model` string.
// User messages carry the prompt text we use to name a session.

const fs = require('fs');

// Approximate USD pricing per 1M tokens. cacheRead is cheap; cacheCreation
// is a premium over base input. Values are estimates for display only.
const PRICING = {
  opus:   { input: 15,  output: 75,  cacheCreation: 18.75, cacheRead: 1.5 },
  sonnet: { input: 3,   output: 15,  cacheCreation: 3.75,  cacheRead: 0.3 },
  haiku:  { input: 0.8, output: 4,   cacheCreation: 1.0,   cacheRead: 0.08 },
  fable:  { input: 1,   output: 5,   cacheCreation: 1.25,  cacheRead: 0.1 },
  _default: { input: 3, output: 15,  cacheCreation: 3.75,  cacheRead: 0.3 },
};

function priceFor(model) {
  const m = (model || '').toLowerCase();
  if (m.includes('opus')) return PRICING.opus;
  if (m.includes('sonnet')) return PRICING.sonnet;
  if (m.includes('haiku')) return PRICING.haiku;
  if (m.includes('fable')) return PRICING.fable;
  return PRICING._default;
}

function estimateCost(tokens, model) {
  const p = priceFor(model);
  const c =
    (tokens.input * p.input +
      tokens.output * p.output +
      tokens.cacheCreation * p.cacheCreation +
      tokens.cacheRead * p.cacheRead) /
    1_000_000;
  return Math.round(c * 10000) / 10000; // 4 dp
}

// Full itemized breakdown for the cost tooltip.
function costBreakdown(tokens, model) {
  const p = priceFor(model);
  const line = (n, rate) => Math.round((n * rate) / 1_000_000 * 10000) / 10000;
  return {
    model: model || 'unknown',
    rates: p, // $ per 1M tokens
    items: [
      { label: 'Input', tokens: tokens.input, rate: p.input, cost: line(tokens.input, p.input) },
      { label: 'Output', tokens: tokens.output, rate: p.output, cost: line(tokens.output, p.output) },
      { label: 'Cache write', tokens: tokens.cacheCreation, rate: p.cacheCreation, cost: line(tokens.cacheCreation, p.cacheCreation) },
      { label: 'Cache read', tokens: tokens.cacheRead, rate: p.cacheRead, cost: line(tokens.cacheRead, p.cacheRead) },
    ],
    total: estimateCost(tokens, model),
  };
}

// Pull the first human-authored prompt to use as a session name hint.
function extractPromptText(entry) {
  const msg = entry && entry.message;
  if (!msg || msg.role !== 'user') return null;
  const c = msg.content;
  if (typeof c === 'string') return c.trim();
  if (Array.isArray(c)) {
    const t = c.find((b) => b && b.type === 'text' && b.text);
    if (t) return String(t.text).trim();
  }
  return null;
}

function parseTranscript(transcriptPath) {
  const empty = {
    tokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0 },
    cost: 0,
    model: null,
    firstPrompt: null,
    messages: 0,
  };
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return empty;

  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return empty;
  }

  const tokens = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0 };
  let model = null;
  let firstPrompt = null;
  let messages = 0;
  let activeMs = 0;         // sum of gaps between entries, capped (active work time)
  let prevTs = null;
  const ACTIVE_GAP_CAP = 5 * 60 * 1000;
  const seen = new Set(); // dedupe assistant usage by message id (streaming repeats)

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    messages++;

    // Active work time from entry timestamps (skip long idle gaps)
    if (entry.timestamp) {
      const ts = new Date(entry.timestamp).getTime();
      if (!isNaN(ts)) {
        if (prevTs != null) {
          const d = ts - prevTs;
          if (d > 0 && d < ACTIVE_GAP_CAP) activeMs += d;
        }
        prevTs = ts;
      }
    }

    if (!firstPrompt) {
      const p = extractPromptText(entry);
      // skip system-injected reminders / tool results; want a real prompt
      if (p && !p.startsWith('<') && p.length > 1) firstPrompt = p;
    }

    const msg = entry.message;
    if (msg && msg.role === 'assistant') {
      if (msg.model) model = msg.model;
      const id = msg.id || entry.uuid;
      if (id && seen.has(id)) continue; // already counted this message
      if (id) seen.add(id);
      const u = msg.usage;
      if (u) {
        tokens.input += u.input_tokens || 0;
        tokens.output += u.output_tokens || 0;
        tokens.cacheCreation += u.cache_creation_input_tokens || 0;
        tokens.cacheRead += u.cache_read_input_tokens || 0;
      }
    }
  }

  tokens.total =
    tokens.input + tokens.output + tokens.cacheCreation + tokens.cacheRead;

  return {
    tokens,
    cost: estimateCost(tokens, model),
    costBreakdown: costBreakdown(tokens, model),
    model,
    firstPrompt: firstPrompt ? firstPrompt.slice(0, 80) : null,
    messages,
    activeMs,
  };
}

module.exports = { parseTranscript, estimateCost, costBreakdown, priceFor };
