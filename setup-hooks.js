#!/usr/bin/env node
// setup-hooks.js — one-command AgentQuest install: wires the Claude Code hooks
// that feed the server into ~/.claude/settings.json.
//
//   npm run setup            merge hooks into ~/.claude/settings.json (with backup)
//   npm run setup -- --dry   show what would change without writing
//   node setup-hooks.js --settings <path>   target a different settings file (tests)
//
// Safe by design: creates a timestamped backup first, merges instead of
// overwriting (your existing hooks are kept), and is idempotent — re-running
// updates AgentQuest's entries in place.

const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const settingsArg = args.indexOf('--settings');
const SETTINGS = settingsArg >= 0 && args[settingsArg + 1]
  ? path.resolve(args[settingsArg + 1])
  : path.join(os.homedir(), '.claude', 'settings.json');

const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'Notification', 'SessionEnd'];
const SCRIPT = path.join(__dirname, 'send-event.ps1').replace(/\\/g, '/');

// read the port from config.json so the hooks point at the right server
let port = 3456;
try { port = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')).port || 3456; } catch {}
const SERVER = `http://127.0.0.1:${port}`;

// powershell on Windows, pwsh elsewhere (PowerShell 7 is cross-platform)
const shell = process.platform === 'win32' ? 'powershell' : 'pwsh';
const commandFor = (event) =>
  `${shell} -NoProfile -ExecutionPolicy Bypass -Command "& '${SCRIPT}' -Type ${event} -Server '${SERVER}'"`;

function isOurs(hookCmd) {
  return typeof hookCmd === 'string' && hookCmd.includes('send-event.ps1');
}

function main() {
  if (!fs.existsSync(path.join(__dirname, 'send-event.ps1'))) {
    console.error('send-event.ps1 not found next to this script — run from the AgentQuest folder.');
    process.exit(1);
  }

  let settings = {};
  let existed = false;
  try {
    settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
    existed = true;
  } catch (e) {
    if (fs.existsSync(SETTINGS)) {
      console.error(`Could not parse ${SETTINGS}: ${e.message}\nFix the JSON (or move the file) and re-run.`);
      process.exit(1);
    }
  }

  settings.hooks = settings.hooks || {};
  const changes = [];

  for (const event of HOOK_EVENTS) {
    const entry = {
      ...(event === 'PreToolUse' || event === 'PostToolUse' ? { matcher: '.*' } : {}),
      hooks: [{ type: 'command', command: commandFor(event) }],
    };
    const existing = settings.hooks[event];
    if (!Array.isArray(existing)) {
      settings.hooks[event] = [entry];
      changes.push(`${event}: added`);
      continue;
    }
    // replace a previous AgentQuest entry, or append alongside the user's own hooks
    let replaced = false;
    for (const matcherBlock of existing) {
      const hooks = (matcherBlock && matcherBlock.hooks) || [];
      for (let i = 0; i < hooks.length; i++) {
        if (isOurs(hooks[i].command)) {
          hooks[i] = { type: 'command', command: commandFor(event) };
          replaced = true;
        }
      }
    }
    if (replaced) changes.push(`${event}: updated existing entry`);
    else { existing.push(entry); changes.push(`${event}: added alongside your existing hooks`); }
  }

  console.log(`AgentQuest hook setup → ${SETTINGS}\nServer: ${SERVER} · Script: ${SCRIPT}\n`);
  for (const c of changes) console.log('  • ' + c);

  if (DRY) { console.log('\n--dry: nothing written.'); return; }

  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  if (existed) {
    const backup = SETTINGS + '.bak-agentquest-' + Date.now();
    fs.copyFileSync(SETTINGS, backup);
    console.log(`\nBackup saved: ${backup}`);
  }
  fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2));
  console.log(`\n✅ Hooks installed. Restart your Claude Code sessions and open ${SERVER} — your agents will walk into the guild.`);
}

main();
