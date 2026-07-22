const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { WebSocketServer } = require('ws');
const { parseTranscript } = require('./transcript');
const { persona, personaAt, NAMES } = require('./persona');
const { describeActivity } = require('./activity');
const roles = require('./roles');
const { startDesktopWatcher } = require('./desktop-watcher');

// Assign a persona whose name isn't already used by another live session.
function assignPersona(id) {
  const used = new Set();
  for (const s of sessions.values()) if (s.persona) used.add(s.persona.name);
  for (let off = 0; off < NAMES.length; off++) {
    const p = personaAt(id, off);
    if (!used.has(p.name)) return p;
  }
  return persona(id);
}

const ACTIVE_GAP_CAP = 5 * 60 * 1000; // gaps longer than 5 min don't count as work

// Config (editable in config.json)
let CONFIG = { port: 3456, staleMinutes: 15, abandonMinutes: 45, autoStart: true };
try {
  CONFIG = { ...CONFIG, ...JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')) };
} catch { /* defaults */ }
// Server-side notifications (reach the user even with no browser tab open).
// toast: native Windows toast · stops: also alert on turn-end ("your turn")
// ntfyTopic/telegram*/webhookUrl: phone push channels · remindMinutes: nag once
CONFIG.notify = {
  toast: true, stops: true, remindMinutes: 10,
  ntfyTopic: '', telegramToken: '', telegramChatId: '', webhookUrl: '',
  ...(CONFIG.notify || {}),
};

function saveConfig() {
  try {
    fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(CONFIG, null, 2));
  } catch (e) {
    console.error('[Config] save failed:', e.message);
  }
}

const PORT = process.env.PORT || CONFIG.port || 3456;
const STATE_FILE = path.join(__dirname, 'sessions.json');
const HISTORY_FILE = path.join(__dirname, 'history.csv');
const HISTORY_HEADER = 'timestamp,sessions,active,waiting,tokens,api_cost_usd,labor_cost_usd\n';
// Durable per-session archive (JSON Lines). Every finished/cleared session is
// appended here so its stats survive after the live card is removed.
const SESSION_HISTORY_FILE = path.join(__dirname, 'sessions-history.jsonl');
// Durable wait->response log (JSON Lines): one row per resolved "needs you" alert.
const RESPONSES_FILE = path.join(__dirname, 'responses.jsonl');

// ---------------------------------------------------------------------------
// Session store (authoritative). Map: sessionId -> session object.
// ---------------------------------------------------------------------------
const sessions = new Map();
const clients = new Set();

function loadState() {
  try {
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    for (const s of data) sessions.set(s.sessionId, s);
    console.log(`[State] Loaded ${sessions.size} session(s) from disk`);
  } catch {
    // no state file yet
  }
}

let saveTimer = null;
function saveState() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify([...sessions.values()], null, 2));
    } catch (e) {
      console.error('[State] save failed:', e.message);
    }
  }, 500);
}

// Append an aggregate metrics snapshot to history.csv (append-only time series).
function appendHistory(reason) {
  if (sessions.size === 0) return;
  let tokens = 0, cost = 0, labor = 0, active = 0, waiting = 0;
  for (const s of sessions.values()) {
    tokens += (s.tokens && s.tokens.total) || 0;
    cost += s.cost || 0;
    labor += (s.labor && s.labor.cost) || 0;
    if (['working', 'thinking', 'starting'].includes(s.state)) active++;
    if (s.needsAttention) waiting++;
  }
  const row = [
    new Date().toISOString(), sessions.size, active, waiting,
    tokens, cost.toFixed(4), labor.toFixed(2),
  ].join(',') + '\n';
  try {
    if (!fs.existsSync(HISTORY_FILE)) fs.writeFileSync(HISTORY_FILE, HISTORY_HEADER);
    fs.appendFileSync(HISTORY_FILE, row);
  } catch (e) {
    console.error('[History] write failed:', e.message);
  }
}
setInterval(() => appendHistory('tick'), 60000);

// ---------------------------------------------------------------------------
// Server-side notifications: native Windows toast + optional phone push.
// These fire from the server so alerts reach the user with no browser open.
// ---------------------------------------------------------------------------
function sendToast(title, body) {
  if (!CONFIG.notify.toast || process.platform !== 'win32') return;
  const script = path.join(__dirname, 'notify.ps1');
  execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Title', title, '-Body', body],
    { timeout: 8000 }, () => {});
}

// Minimal dependency-free HTTP(S) POST (fire and forget).
function postHTTP(urlStr, headers, bodyStr) {
  try {
    const u = new URL(urlStr);
    const mod = u.protocol === 'https:' ? require('https') : require('http');
    const req = mod.request(u, { method: 'POST', headers }, (res) => res.resume());
    req.on('error', () => {});
    req.end(bodyStr);
  } catch { /* bad url — ignore */ }
}

function sendPush(title, body) {
  const n = CONFIG.notify;
  if (n.ntfyTopic) {
    // ntfy.sh: free push to iOS/Android; header values must be ASCII
    postHTTP(`https://ntfy.sh/${encodeURIComponent(n.ntfyTopic)}`,
      { 'Content-Type': 'text/plain', 'Title': title.replace(/[^\x20-\x7E]/g, '').trim() || 'Ravenspire', 'Tags': 'bell' },
      body);
  }
  if (n.telegramToken && n.telegramChatId) {
    postHTTP(`https://api.telegram.org/bot${n.telegramToken}/sendMessage`,
      { 'Content-Type': 'application/json' },
      JSON.stringify({ chat_id: n.telegramChatId, text: `${title}\n${body}` }));
  }
  if (n.webhookUrl) {
    postHTTP(n.webhookUrl, { 'Content-Type': 'application/json' }, JSON.stringify({ app: 'ai-hq', title, body }));
  }
}

function notifyAlert(s, kind) {
  const title = kind === 'remind' ? `⏳ Still waiting: ${s.name}` : `🔔 ${s.name} needs you`;
  const body = `${s.attentionReason || 'Waiting for input'} · ${s.title || ''}`;
  sendToast(title, body);
  sendPush(title, body);
}

// ---------------------------------------------------------------------------
// Response-time tracking: how long an agent waited before the user acted.
// One durable JSONL row per resolved alert; via tells HOW it resolved:
//   reply (user prompt) · resumed (tool/permission approved) · focus (card click)
//   abandoned (alert timed out) · ended (session ended while waiting)
// ---------------------------------------------------------------------------
const recentResponses = [];
function recordResponse(s, via) {
  if (!s || !s.needsAttention || !s.waitingSince) return;
  const waitedMs = Date.now() - new Date(s.waitingSince).getTime();
  if (!(waitedMs > 500)) return; // sub-second flaps are noise
  const rec = {
    sessionId: s.sessionId,
    name: s.name || (s.persona && s.persona.name) || null,
    project: s.title || null,
    reason: s.attentionReason || null,
    waitingSince: s.waitingSince,
    respondedAt: new Date().toISOString(),
    waitedMs,
    via,
  };
  try { fs.appendFileSync(RESPONSES_FILE, JSON.stringify(rec) + '\n'); } catch (e) { console.error('[Responses] write failed:', e.message); }
  recentResponses.unshift(rec);
  if (recentResponses.length > 200) recentResponses.pop();
}

// Common per-session fields used by both the durable archive and the live merge.
function sessionSnapshot(s) {
  return {
    sessionId: s.sessionId,
    name: s.name || (s.persona && s.persona.name) || s.title || null,
    persona: (s.persona && s.persona.name) || null,
    task: s.task || null,
    title: s.title || null,
    cwd: s.cwd || null,
    ide: s.ide || null,
    source: s.source || 'code',
    host: s.host || null,
    model: s.model || null,
    role: s.customRole || s.role || null,
    startTime: s.startTime || null,
    endTime: s.lastActivity || null,
    activeMs: s.activeMs || 0,
    tokens: s.tokens || null,
    cost: s.cost || 0,
    labor: s.labor || null,
    messages: s.messages || 0,
    toolCount: s.toolCount || 0,
    toolBreakdown: s.toolBreakdown || {},
    lastMessage: s.lastMessage || null,
  };
}

// Append a durable snapshot of a single session to sessions-history.jsonl.
// Idempotent per session via the `archived` flag (persisted in sessions.json),
// so a session that ends and is later cleared is only written once.
function archiveSession(s, reason) {
  if (!s || s.archived) return;
  s.archived = true;
  const rec = { ...sessionSnapshot(s), archivedAt: new Date().toISOString(), endReason: reason };
  try {
    fs.appendFileSync(SESSION_HISTORY_FILE, JSON.stringify(rec) + '\n');
  } catch (e) {
    console.error('[History] session archive failed:', e.message);
  }
}

// Sweep stale sessions so a crashed/closed session doesn't linger as "working"
// or keep a stuck alert pulsing forever.
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const s of sessions.values()) {
    if (s.state === 'ended') continue;
    const idleMs = now - new Date(s.lastActivity).getTime();
    if (idleMs > CONFIG.staleMinutes * 60000 && !['idle', 'waiting'].includes(s.state)) {
      s.state = 'idle';
      s.activity = 'Idle';
      changed = true;
    }
    // still waiting after remindMinutes — nag the human once
    if (s.needsAttention && !s.reminded && s.waitingSince && CONFIG.notify.remindMinutes > 0 &&
        now - new Date(s.waitingSince).getTime() > CONFIG.notify.remindMinutes * 60000) {
      s.reminded = true;
      notifyAlert(s, 'remind');
      changed = true;
    }
    // clearly abandoned — drop the alert so the banner isn't stuck
    if (s.needsAttention && idleMs > CONFIG.abandonMinutes * 60000) {
      recordResponse(s, 'abandoned');
      s.needsAttention = false;
      s.attentionReason = null;
      changed = true;
    }
  }
  if (changed) { saveState(); broadcast(); }
}, 30000);

// Map raw hook event names / legacy types to an internal state.
function stateForEvent(type, hookEvent) {
  const e = (hookEvent || type || '').toLowerCase();
  if (e.includes('sessionstart')) return 'starting';
  if (e.includes('userpromptsubmit')) return 'working';
  if (e.includes('pretooluse') || type === 'tool_start') return 'working';
  if (e.includes('posttooluse') || type === 'tool_end') return 'working';
  if (e.includes('notification')) return 'waiting';
  if (e === 'stop' || e.includes('stop')) return 'idle';
  if (e.includes('sessionend')) return 'ended';
  return null;
}

function upsertSession(ev) {
  const id = ev.sessionId || 'unknown';
  let s = sessions.get(id);
  const now = new Date().toISOString();

  if (!s) {
    s = {
      sessionId: id,
      persona: assignPersona(id),  // stable {name,color,initial}, unique among live
      customName: null,            // user override of the persona name
      activity: 'Starting up',     // live "what it's doing" line
      model: null,
      ide: ev.ide || 'cli',
      source: ev.source === 'cowork' ? 'cowork' : 'code', // 'code' (hooks) | 'cowork' (desktop log)
      title: ev.title || 'session',
      cwd: ev.cwd || '',
      state: 'starting',
      startTime: now,
      lastActivity: now,
      currentTool: null,
      lastTarget: null,
      toolCount: 0,
      toolBreakdown: {},
      role: null,
      customRole: null,
      activeMs: 0,
      needsAttention: false,
      attentionReason: null,
      waitingSince: null,
      host: ev.host || null,
      windowPid: null,
      windowName: null,
      windowTitle: null,
      tokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0 },
      cost: 0,
      messages: 0,
      transcriptPath: ev.transcriptPath || '',
    };
    sessions.set(id, s);
  }
  if (!s.persona) s.persona = assignPersona(id); // migrate old persisted sessions
  if (s.activeMs == null) s.activeMs = 0;

  // Accumulate active work time: count the gap since the last event only if the
  // agent was actively working and the gap is short (not a long idle stretch).
  const prevActive = ['working', 'thinking', 'starting'].includes(s.state);
  const gap = Date.now() - new Date(s.lastActivity).getTime();
  if (prevActive && gap > 0 && gap < ACTIVE_GAP_CAP) s.activeMs += gap;

  // Always refresh cheap fields
  s.lastActivity = now;
  // Source: a native hook event is authoritative 'code'; cowork-log events only
  // set 'cowork' when we've never seen a hook for this session (VM cowork, etc.).
  if (ev.source === 'cowork') { if (s.source !== 'code') s.source = 'cowork'; }
  else s.source = 'code';
  if (ev.ide) s.ide = ev.ide;
  if (ev.title) s.title = ev.title;
  if (ev.cwd) s.cwd = ev.cwd;
  if (ev.transcriptPath) s.transcriptPath = ev.transcriptPath;
  if (ev.host) s.host = ev.host;
  if (ev.windowPid) { // captured on lifecycle events (start/prompt/stop/notification)
    s.windowPid = ev.windowPid;
    s.windowName = ev.windowName || null;
    s.windowTitle = ev.windowTitle || null;
  }
  if (ev.windowChain) s.windowChain = ev.windowChain;

  // Role: infer once from the project, allow user override
  if (!s.role) s.role = roles.inferRole({ title: s.title, cwd: s.cwd });

  // State machine
  const next = stateForEvent(ev.type, ev.hookEvent);
  if (next) s.state = next;

  // "Needs you" attention flag
  const evtName = (ev.hookEvent || ev.type || '').toLowerCase();
  const wasAttention = s.needsAttention;
  if (evtName.includes('notification')) {
    s.needsAttention = true;
    s.attentionReason = ev.message ? String(ev.message).slice(0, 80) : 'Needs your input';
    if (!wasAttention) s.waitingSince = now;
  } else if (evtName === 'stop' || evtName.includes('stop')) {
    s.needsAttention = true;
    s.attentionReason = 'Finished — your turn';
    if (!wasAttention) s.waitingSince = now;
  } else if (
    evtName.includes('userpromptsubmit') || evtName.includes('pretooluse') ||
    evtName.includes('posttooluse') || evtName.includes('sessionstart') ||
    ev.type === 'tool_start' || ev.type === 'tool_end'
  ) {
    // agent is active again — the user responded; record how long it waited
    if (wasAttention) recordResponse(s, evtName.includes('userpromptsubmit') ? 'reply' : 'resumed');
    s.needsAttention = false;
    s.attentionReason = null;
    s.waitingSince = null;
    s.reminded = false;
  } else if (evtName.includes('sessionend')) {
    if (wasAttention) recordResponse(s, 'ended');
    s.needsAttention = false;
    s.attentionReason = null;
  }
  // Alert just rose: push it to the human (toast + phone). Stop events ("your
  // turn") are gated by notify.stops; explicit Notifications always fire.
  // A per-session 45s dedupe stops rapid re-fires from chatty hooks.
  if (s.needsAttention && !wasAttention) {
    s.reminded = false;
    const isStop = evtName === 'stop' || evtName.includes('stop');
    const wantPush = isStop ? CONFIG.notify.stops !== false : true;
    if (wantPush && (!s.lastNotifyAt || Date.now() - s.lastNotifyAt > 45000)) {
      s.lastNotifyAt = Date.now();
      notifyAlert(s, 'alert');
    }
  }

  const isPre = (ev.hookEvent || ev.type || '').toLowerCase().includes('pretooluse') || ev.type === 'tool_start';
  const isPost = (ev.hookEvent || ev.type || '').toLowerCase().includes('posttooluse') || ev.type === 'tool_end';
  const cleanTarget = ev.target ? String(ev.target).replace(/\s+/g, ' ').trim().slice(0, 60) : null;
  if (isPre) {
    s.currentTool = ev.tool || null;
    s.lastTarget = cleanTarget;
    s.toolCount = (s.toolCount || 0) + 1;
    if (ev.tool) {
      if (!s.toolBreakdown) s.toolBreakdown = {};
      s.toolBreakdown[ev.tool] = (s.toolBreakdown[ev.tool] || 0) + 1;
    }
  } else if (isPost) {
    s.currentTool = null;
  }

  // Live activity line: describe what the agent is doing right now
  s.activity = describeActivity({
    state: s.state,
    tool: ev.tool || s.currentTool,
    target: cleanTarget || s.lastTarget,
    hookEvent: ev.hookEvent || ev.type,
  });

  // Enrich from transcript (tokens, model, name hint) when available
  if (s.transcriptPath) {
    const t = parseTranscript(s.transcriptPath);
    if (t.model) s.model = t.model;
    if (t.tokens && t.tokens.total > 0) {
      s.tokens = t.tokens;
      s.cost = t.cost;
      s.costBreakdown = t.costBreakdown;
    }
    if (t.messages) s.messages = t.messages;
    if (t.firstPrompt) s.task = t.firstPrompt; // what this session is about
    if (t.lastAssistantText) s.lastMessage = t.lastAssistantText; // the agent's latest words (the question, when waiting)
    // Transcript timestamps give the most accurate (and retroactive) active time
    if (t.activeMs && t.activeMs > s.activeMs) s.activeMs = t.activeMs;
  }

  // Display name = the persona (or a user override). The task/project are
  // shown separately as context.
  s.name = s.customName || (s.persona && s.persona.name) || s.title;

  // Labor cost: active work hours * the role's human hourly rate
  const effectiveRole = s.customRole || s.role;
  s.labor = roles.laborSummary(s.activeMs, effectiveRole);

  saveState();
  return s;
}

function broadcast() {
  const msg = JSON.stringify({ type: 'sessions', sessions: [...sessions.values()] });
  for (const c of clients) if (c.readyState === 1) c.send(msg);
}

// Emit a legacy-format event so the pixel office (which keys on
// tool_start/tool_end/session_end) keeps working without modification.
function broadcastLegacy(ev) {
  const e = (ev.hookEvent || ev.type || '').toLowerCase();
  let legacyType = null;
  if (e.includes('posttooluse') || ev.type === 'tool_end' || e === 'stop' || e.includes('notification')) legacyType = 'tool_end';
  else if (e.includes('pretooluse') || ev.type === 'tool_start' || e.includes('sessionstart') || e.includes('userpromptsubmit')) legacyType = 'tool_start';
  else if (e.includes('sessionend')) legacyType = 'session_end';
  if (!legacyType) return;
  const msg = JSON.stringify({
    type: legacyType,
    tool: ev.tool || '',
    sessionId: ev.sessionId,
    title: ev.title || '',
    cwd: ev.cwd || '',
  });
  for (const c of clients) if (c.readyState === 1) c.send(msg);
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // JSON: all sessions
  if (req.url === '/sessions') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([...sessions.values()], null, 2));
    return;
  }

  // Debug/status
  if (req.url === '/status' || req.url === '/debug') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      server: 'running',
      connectedClients: clients.size,
      sessionCount: sessions.size,
      recentEvents: (global.recentEvents || []).slice(0, 20),
    }, null, 2));
    return;
  }

  // Focus a session's window: POST /focus {sessionId}
  if (req.method === 'POST' && req.url === '/focus') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let s;
      try { s = sessions.get(JSON.parse(body).sessionId); } catch {}
      const reply = (obj) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (!s) return reply({ ok: false, reason: 'unknown session' });
      if (s.host && s.host.toLowerCase() !== os.hostname().toLowerCase()) return reply({ ok: false, reason: `runs on ${s.host}, not this machine` });
      // Clicking a session = acknowledging it; clear the alert.
      if (s.needsAttention) { recordResponse(s, 'focus'); s.needsAttention = false; s.attentionReason = null; s.waitingSince = null; saveState(); broadcast(); }

      // Claude Desktop: open the exact session/conversation via deep link
      // (claude://resume?session=<uuid> -> importCliSession). Better than window focus.
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.sessionId || '');
      if (s.ide === 'claude-desktop' && isUuid) {
        execFile('powershell', ['-NoProfile', '-Command', `Start-Process 'claude://resume?session=${s.sessionId}'`],
          { timeout: 4000 }, (err) => reply({ ok: !err, result: err ? err.message : 'deeplink' }));
        return;
      }

      // Terminals / IDEs: bring the captured window to the front.
      if (!s.windowPid) return reply({ ok: false, reason: 'window not known yet — interact with that session once' });
      const script = path.join(__dirname, 'focus-window.ps1');
      execFile('powershell', ['-ExecutionPolicy', 'Bypass', '-File', script, '-WindowPid', String(s.windowPid)],
        { timeout: 4000 }, (err, stdout) => {
          const out = (stdout || '').trim();
          reply({ ok: !err && out === 'focused', result: out || (err && err.message) });
        });
    });
    return;
  }

  // Open a session's working directory in the OS file explorer: POST /open-folder {sessionId}
  // Path comes from the stored session (never a client-supplied path) and must be a real dir.
  if (req.method === 'POST' && req.url === '/open-folder') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const reply = (obj, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      let s;
      try { s = sessions.get(JSON.parse(body).sessionId); } catch {}
      if (!s) return reply({ ok: false, reason: 'unknown session' });
      if (s.host && s.host.toLowerCase() !== os.hostname().toLowerCase()) return reply({ ok: false, reason: `runs on ${s.host}, not this machine` });
      const dir = s.cwd;
      if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return reply({ ok: false, reason: 'folder not found on this machine' });
      const opener = process.platform === 'win32' ? 'explorer' : (process.platform === 'darwin' ? 'open' : 'xdg-open');
      // explorer.exe returns a non-zero exit code even on success, so don't treat that as failure.
      execFile(opener, [dir], { timeout: 4000 }, () => {});
      reply({ ok: true, path: dir });
    });
    return;
  }

  // Per-session history: durable archive (JSONL) merged with currently-tracked
  // live sessions, deduped by sessionId, newest first. Live sessions appear
  // immediately (marked live:true); once they end/clear the archive row wins.
  if (req.url.split('?')[0] === '/history/sessions') {
    fs.readFile(SESSION_HISTORY_FILE, 'utf8', (err, data) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const byId = new Map();
      // 1) durable archive (finished sessions)
      if (!err) {
        for (const line of data.split('\n')) {
          if (!line.trim()) continue;
          try {
            const r = JSON.parse(line);
            const prev = byId.get(r.sessionId);
            if (!prev || new Date(r.archivedAt) >= new Date(prev.archivedAt)) byId.set(r.sessionId, { ...r, live: false });
          } catch { /* skip malformed line */ }
        }
      }
      // 2) live/in-memory sessions not yet archived
      for (const s of sessions.values()) {
        if (s.archived || byId.has(s.sessionId)) continue;
        byId.set(s.sessionId, {
          ...sessionSnapshot(s),
          archivedAt: s.lastActivity,
          endReason: null,
          live: true,
          state: s.state,
        });
      }
      const arr = [...byId.values()].sort((a, b) => new Date(b.archivedAt) - new Date(a.archivedAt));
      res.end(JSON.stringify(arr));
    });
    return;
  }

  // Aggregate time-series (raw CSV). Note: the `/history` page is served as HTML below.
  if (req.url === '/history.csv') {
    fs.readFile(HISTORY_FILE, (err, content) => {
      res.writeHead(200, { 'Content-Type': 'text/csv' });
      res.end(err ? HISTORY_HEADER : content);
    });
    return;
  }

  // Available roles + salary table (for the role dropdown / tooltip)
  if (req.url === '/roles') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      roles: roles.ROLE_LIST,
      salaries: roles.SALARIES,
      hoursPerYear: roles.WORK_HOURS_PER_YEAR,
    }));
    return;
  }

  // Set a session's role: POST /role {sessionId, role}
  if (req.method === 'POST' && req.url === '/role') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const { sessionId, role } = JSON.parse(body);
        const s = sessions.get(sessionId);
        if (s) {
          s.customRole = role || null;
          s.labor = roles.laborSummary(s.activeMs, role || s.role);
          saveState(); broadcast();
        }
        res.writeHead(200); res.end('{"ok":true}');
      } catch { res.writeHead(400); res.end('{"error":"bad json"}'); }
    });
    return;
  }

  // Rename a session: POST /rename {sessionId, name}
  if (req.method === 'POST' && req.url === '/rename') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const { sessionId, name } = JSON.parse(body);
        const s = sessions.get(sessionId);
        if (s) { s.customName = name || null; s.name = name || (s.persona && s.persona.name) || s.title; saveState(); broadcast(); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch { res.writeHead(400); res.end('{"error":"bad json"}'); }
    });
    return;
  }

  // Clear ended/stale sessions: POST /clear {sessionId?}
  if (req.method === 'POST' && req.url === '/clear') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const { sessionId } = body ? JSON.parse(body) : {};
        // Archive before removing so clearing the board never loses history.
        if (sessionId) {
          archiveSession(sessions.get(sessionId), 'cleared');
          sessions.delete(sessionId);
        } else {
          for (const s of sessions.values()) archiveSession(s, 'cleared');
          sessions.clear();
        }
        saveState(); broadcast();
        res.writeHead(200); res.end('{"ok":true}');
      } catch { res.writeHead(400); res.end('{"error":"bad json"}'); }
    });
    return;
  }

  if (req.url === '/restart') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: 'Restarting...' }));
    setTimeout(() => process.exit(0), 100);
    return;
  }

  // "Start with Windows" — reflects/toggles the Startup-folder shortcut created
  // by install-autostart.ps1. GET reports state; POST {enabled} installs/removes it.
  if (req.url === '/autostart') {
    const startupDir = process.env.APPDATA
      ? path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
      : path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    const lnk = path.join(startupDir, 'Ravenspire.lnk');
    // pre-rename installs (AI HQ → AgentQuest → Ravenspire)
    const legacyLnks = ['AgentQuest.lnk', 'AI HQ.lnk'].map((n) => path.join(startupDir, n));
    const isEnabled = () => fs.existsSync(lnk) || legacyLnks.some((p) => fs.existsSync(p));
    const reply = (obj, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

    if (req.method === 'GET') {
      if (process.platform !== 'win32') return reply({ ok: true, supported: false, enabled: false });
      return reply({ ok: true, supported: true, enabled: isEnabled() });
    }
    if (req.method === 'POST') {
      if (process.platform !== 'win32') return reply({ ok: false, supported: false, reason: 'Windows only' }, 400);
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let enabled;
        try { enabled = !!JSON.parse(body).enabled; } catch { return reply({ ok: false, reason: 'bad json' }, 400); }
        const script = path.join(__dirname, enabled ? 'install-autostart.ps1' : 'uninstall-autostart.ps1');
        execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
          { timeout: 15000 }, (err, stdout, stderr) => {
            if (err) return reply({ ok: false, enabled: isEnabled(), error: (stderr || err.message || '').trim() }, 500);
            reply({ ok: true, enabled: isEnabled(), result: (stdout || '').trim() });
          });
      });
      return;
    }
  }

  // Wait->response analytics: durable log rows, newest first (last 1000)
  if (req.url === '/responses') {
    fs.readFile(RESPONSES_FILE, 'utf8', (err, data) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (err) return res.end('[]');
      const rows = [];
      const lines = data.split('\n');
      for (let i = lines.length - 1; i >= 0 && rows.length < 1000; i--) {
        if (!lines[i].trim()) continue;
        try { rows.push(JSON.parse(lines[i])); } catch { /* skip malformed */ }
      }
      res.end(JSON.stringify(rows));
    });
    return;
  }

  // Notification settings (secrets stay server-side; only presence is reported)
  if (req.url === '/notify-config') {
    const reply = (obj, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.method === 'GET') {
      const n = CONFIG.notify;
      return reply({
        ok: true, toast: n.toast !== false, stops: n.stops !== false,
        remindMinutes: n.remindMinutes, ntfyTopic: n.ntfyTopic || '',
        hasTelegram: !!(n.telegramToken && n.telegramChatId), hasWebhook: !!n.webhookUrl,
      });
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          const b = JSON.parse(body);
          if (typeof b.toast === 'boolean') CONFIG.notify.toast = b.toast;
          if (typeof b.stops === 'boolean') CONFIG.notify.stops = b.stops;
          if (typeof b.ntfyTopic === 'string') CONFIG.notify.ntfyTopic = b.ntfyTopic.trim();
          if (Number.isFinite(+b.remindMinutes)) CONFIG.notify.remindMinutes = Math.max(0, +b.remindMinutes);
          saveConfig();
          reply({ ok: true });
        } catch { reply({ ok: false, reason: 'bad json' }, 400); }
      });
      return;
    }
  }

  // Fire a test notification through every configured channel
  if (req.method === 'POST' && req.url === '/notify-test') {
    sendToast('🔔 Ravenspire test', 'Server notifications are working.');
    sendPush('🔔 Ravenspire test', 'Server notifications are working.');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      channels: {
        toast: CONFIG.notify.toast !== false && process.platform === 'win32',
        ntfy: !!CONFIG.notify.ntfyTopic,
        telegram: !!(CONFIG.notify.telegramToken && CONFIG.notify.telegramChatId),
        webhook: !!CONFIG.notify.webhookUrl,
      },
    }));
    return;
  }

  // Event endpoint — hooks POST here
  if (req.method === 'POST' && req.url === '/event') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const ev = JSON.parse(body);
        console.log(`[Event] ${ev.hookEvent || ev.type} | tool=${ev.tool || ''} | ide=${ev.ide || ''} | session=${(ev.sessionId || '').slice(0, 8)} | ${ev.title || ''}`);

        if (!global.recentEvents) global.recentEvents = [];
        global.recentEvents.unshift({ time: new Date().toISOString(), ...ev });
        if (global.recentEvents.length > 20) global.recentEvents.pop();

        upsertSession(ev);
        broadcast();
        broadcastLegacy(ev);
        // snapshot history when a session ends (captures the drop) and durably
        // archive that session's final stats so they outlive the live card.
        if ((ev.hookEvent || ev.type || '').toLowerCase().includes('sessionend')) {
          appendHistory('session_end');
          archiveSession(sessions.get(ev.sessionId || 'unknown'), 'session_end');
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  // Static files
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/app.html';                 // shell: keeps all views mounted
  else if (urlPath === '/dashboard' || urlPath === '/dashboard/') urlPath = '/dashboard.html';
  else if (urlPath === '/history' || urlPath === '/history/') urlPath = '/history.html';
  else if (urlPath === '/rpg' || urlPath === '/rpg/' || urlPath === '/game') urlPath = '/rpg.html';
  let filePath = path.join(__dirname, urlPath);
  const ext = path.extname(filePath);
  const contentTypes = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
  };
  fs.readFile(filePath, (err, content) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'text/plain' });
    res.end(content);
  });
});

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'connected' }));
  ws.send(JSON.stringify({ type: 'sessions', sessions: [...sessions.values()] }));
  ws.on('close', () => clients.delete(ws));
});

loadState();
server.listen(PORT, '0.0.0.0', () => {
  const os = require('os');
  const nets = os.networkInterfaces();
  let localIP = 'YOUR_IP';
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) if (net.family === 'IPv4' && !net.internal) { localIP = net.address; break; }
  }
  console.log(`
+--------------------------------------------------+
|              ⚔  A G E N T Q U E S T  ⚔           |
+--------------------------------------------------+
  Quest world:   http://localhost:${PORT}
  Control panel: http://localhost:${PORT}/dashboard
  History:       http://localhost:${PORT}/history
  Network:       http://${localIP}:${PORT}
  Events:        POST http://localhost:${PORT}/event

The guild doors are open. Waiting for agents...`);
});

// Tail Claude Desktop's main.log to surface cowork / desktop-hosted sessions that
// don't POST here themselves. Disable with "watchDesktop": false in config.json.
if (CONFIG.watchDesktop !== false) {
  try {
    startDesktopWatcher((ev) => {
      if (!global.recentEvents) global.recentEvents = [];
      global.recentEvents.unshift({ time: new Date().toISOString(), ...ev });
      if (global.recentEvents.length > 20) global.recentEvents.pop();
      upsertSession(ev);
      broadcast();
      broadcastLegacy(ev);
    }, { logPath: CONFIG.desktopLogPath });
    if (process.platform === 'win32') console.log('[Desktop] watching main.log for cowork sessions');
  } catch (e) {
    console.error('[Desktop] watcher failed to start:', e.message);
  }
}
