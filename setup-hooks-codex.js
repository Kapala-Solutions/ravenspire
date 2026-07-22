#!/usr/bin/env node
// setup-hooks-codex.js — one-command Ravenspire install for OpenAI Codex.
// Wires Codex's lifecycle hooks into ~/.codex/hooks.json so Codex sessions feed
// the same server (and walk into the same guild) as Claude Code sessions.
//
//   npm run setup:codex            merge hooks into ~/.codex/hooks.json (with backup)
//   npm run setup:codex -- --dry   show what would change without writing
//   node setup-hooks-codex.js --hooks <path>   target a different hooks file (tests)
//
// Codex and Claude Code share hook payload field names (session_id, cwd,
// tool_name, tool_input, prompt, last_assistant_message), so both point at the
// SAME send-event.ps1 — Codex just passes `-Source codex` so the server can tag
// and badge those sessions. Safe by design: timestamped backup, merge (your own
// hooks are kept), idempotent (re-running updates Ravenspire's entries in place).
//
// Note: Codex has no SessionEnd hook, so Codex heroes leave the board via the
// server's stale sweep (config.json staleMinutes/abandonMinutes) instead.

const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const hooksArg = args.indexOf('--hooks');
const HOOKS_FILE = hooksArg >= 0 && args[hooksArg + 1]
  ? path.resolve(args[hooksArg + 1])
  : path.join(os.homedir(), '.codex', 'hooks.json');

// Codex's valid lifecycle events we care about. PermissionRequest is Codex's
// "needs you" (approval prompt) — the analog of Claude's Notification.
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PermissionRequest']);
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop'];
const SCRIPT = path.join(__dirname, 'send-event.ps1').replace(/\\/g, '/');

// read the port from config.json so the hooks point at the right server
let port = 3456;
try { port = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')).port || 3456; } catch {}
const SERVER = `http://127.0.0.1:${port}`;

// command runs on macOS/Linux (pwsh); commandWindows overrides it on Windows.
const pwshCmd = (event, exe) =>
  `${exe} -NoProfile -ExecutionPolicy Bypass -File "${SCRIPT}" -Type ${event} -Source codex -Server "${SERVER}"`;

function hookObj(event) {
  return {
    type: 'command',
    command: pwshCmd(event, 'pwsh'),
    commandWindows: pwshCmd(event, 'powershell'),
    statusMessage: 'Ravenspire',
  };
}
function entryFor(event) {
  return {
    ...(TOOL_EVENTS.has(event) ? { matcher: '.*' } : {}),
    hooks: [hookObj(event)],
  };
}
function isOurs(cmd) {
  return typeof cmd === 'string' && cmd.includes('send-event.ps1');
}

function main() {
  if (!fs.existsSync(path.join(__dirname, 'send-event.ps1'))) {
    console.error('send-event.ps1 not found next to this script — run from the Ravenspire folder.');
    process.exit(1);
  }

  let root = {};
  let existed = false;
  try {
    root = JSON.parse(fs.readFileSync(HOOKS_FILE, 'utf8'));
    existed = true;
  } catch (e) {
    if (fs.existsSync(HOOKS_FILE)) {
      console.error(`Could not parse ${HOOKS_FILE}: ${e.message}\nFix the JSON (or move the file) and re-run.`);
      process.exit(1);
    }
  }

  if (!root.description) root.description = 'Lifecycle hooks (Ravenspire + your own).';
  root.hooks = root.hooks || {};
  const changes = [];

  for (const event of HOOK_EVENTS) {
    const entry = entryFor(event);
    const existing = root.hooks[event];
    if (!Array.isArray(existing)) {
      root.hooks[event] = [entry];
      changes.push(`${event}: added`);
      continue;
    }
    // replace a previous Ravenspire entry, or append alongside the user's own hooks
    let replaced = false;
    for (const matcherBlock of existing) {
      const hooks = (matcherBlock && matcherBlock.hooks) || [];
      for (let i = 0; i < hooks.length; i++) {
        if (isOurs(hooks[i].command) || isOurs(hooks[i].commandWindows)) {
          hooks[i] = hookObj(event);
          replaced = true;
        }
      }
    }
    if (replaced) changes.push(`${event}: updated existing entry`);
    else { existing.push(entry); changes.push(`${event}: added alongside your existing hooks`); }
  }

  console.log(`Ravenspire Codex hook setup → ${HOOKS_FILE}\nServer: ${SERVER} · Script: ${SCRIPT}\n`);
  for (const c of changes) console.log('  • ' + c);

  if (DRY) { console.log('\n--dry: nothing written.'); return; }

  fs.mkdirSync(path.dirname(HOOKS_FILE), { recursive: true });
  if (existed) {
    const backup = HOOKS_FILE + '.bak-ravenspire-' + Date.now();
    fs.copyFileSync(HOOKS_FILE, backup);
    console.log(`\nBackup saved: ${backup}`);
  }
  fs.writeFileSync(HOOKS_FILE, JSON.stringify(root, null, 2));
  console.log(`\n✅ Codex hooks installed. Start a new Codex session and open ${SERVER} — Codex agents will join the guild (✳️ codex badge). Restart the Ravenspire server first so it has the code that recognizes Codex sessions.`);
}

main();
