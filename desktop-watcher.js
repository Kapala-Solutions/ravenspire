// desktop-watcher.js — capture Claude Desktop "local" sessions (cowork / desktop-
// hosted agent) by tailing the app's main.log. These sessions use `local_<uuid>`
// ids; some run in the cowork VM whose in-VM hooks can't reach the host panel on
// localhost:3456, so tailing the host log is the only way to see them.
//
// Best-effort by nature: the log format is undocumented and may shift across
// Claude Desktop versions. The watcher is defensive (never throws into the server)
// and can be disabled with `"watchDesktop": false` in config.json.

const fs = require('fs');
const os = require('os');
const path = require('path');

function defaultLogPath() {
  const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appdata, 'Claude', 'logs', 'main.log');
}

// Start tailing. `onEvent(ev)` receives normalized events shaped like the hook
// payloads the server already understands (plus source:'cowork'). Returns a stop fn.
function startDesktopWatcher(onEvent, opts = {}) {
  if (process.platform !== 'win32') return () => {};
  const logPath = opts.logPath || defaultLogPath();
  const interval = opts.interval || 2000;
  let pos = 0;
  let carry = '';
  let lastFocused = null;
  let lastRaw = null;   // collapse the app's duplicated log lines
  let timer = null;
  let stopped = false;

  // Start at end-of-file so we don't replay the whole history as fake sessions.
  try { pos = fs.statSync(logPath).size; } catch { pos = 0; }

  function emit(ev) { try { onEvent(ev); } catch { /* never break the server */ } }

  function handleLine(line) {
    if (line === lastRaw) return;   // skip the immediate duplicate the app writes
    lastRaw = line;
    const m = /LocalSessions\.(\w+):(.*)$/.exec(line);
    if (!m) return;
    const method = m[1];
    const rest = m[2];
    const idM = /sessionId=local_([0-9a-f-]{36})/i.exec(rest);
    const id = idM ? idM[1] : null;
    if (id) lastFocused = id;
    const base = { source: 'cowork', ide: 'claude-desktop', host: os.hostname() };

    switch (method) {
      case 'updateSession': {
        const tM = /"title":"((?:[^"\\]|\\.)*)"/.exec(rest);
        if (id) {
          let title = null;
          if (tM) { try { title = JSON.parse('"' + tM[1] + '"'); } catch { title = tM[1]; } }
          emit({ ...base, sessionId: id, title, hookEvent: 'CoworkUpdate' });
        }
        break;
      }
      case 'setFocusedSession':
        if (id) emit({ ...base, sessionId: id, hookEvent: 'CoworkFocus' });
        break;
      case 'sendMessage':
        if (id) emit({ ...base, sessionId: id, hookEvent: 'UserPromptSubmit' });
        break;
      case 'startShellPty':
        if (id) emit({ ...base, sessionId: id, hookEvent: 'PreToolUse', tool: 'Shell' });
        break;
      case 'respondToToolPermission':
        if (id) emit({ ...base, sessionId: id, hookEvent: 'PreToolUse' });
        break;
      case 'checkTrust':
      case 'checkGhAvailable': {
        const cM = /cwd=(.+?)(?:,\s*\w+=|$)/.exec(rest);
        if (cM && lastFocused) emit({ ...base, sessionId: lastFocused, cwd: cM[1].trim(), hookEvent: 'CoworkCwd' });
        break;
      }
      default:
        break;
    }
  }

  function schedule() { if (!stopped) timer = setTimeout(poll, interval); }

  function poll() {
    if (stopped) return;
    fs.stat(logPath, (err, st) => {
      if (err) return schedule();
      if (st.size < pos) { pos = 0; carry = ''; }   // rotated / truncated
      if (st.size <= pos) return schedule();
      const stream = fs.createReadStream(logPath, { start: pos, end: st.size - 1, encoding: 'utf8' });
      let buf = '';
      stream.on('data', (d) => (buf += d));
      stream.on('error', () => schedule());
      stream.on('end', () => {
        pos = st.size;
        const lines = (carry + buf).split(/\r?\n/);
        carry = lines.pop();   // keep the trailing partial line for next read
        for (const ln of lines) handleLine(ln);
        schedule();
      });
    });
  }

  poll();
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}

module.exports = { startDesktopWatcher, defaultLogPath };
