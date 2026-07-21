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

const PORT = process.env.PORT || CONFIG.port || 3456;
const STATE_FILE = path.join(__dirname, 'sessions.json');
const HISTORY_FILE = path.join(__dirname, 'history.csv');
const HISTORY_HEADER = 'timestamp,sessions,active,waiting,tokens,api_cost_usd,labor_cost_usd\n';
// Durable per-session archive (JSON Lines). Every finished/cleared session is
// appended here so its stats survive after the live card is removed.
const SESSION_HISTORY_FILE = path.join(__dirname, 'sessions-history.jsonl');

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
    // clearly abandoned — drop the alert so the banner isn't stuck
    if (s.needsAttention && idleMs > CONFIG.abandonMinutes * 60000) {
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
  if (evtName.includes('notification')) {
    s.needsAttention = true;
    s.attentionReason = ev.message ? String(ev.message).slice(0, 80) : 'Needs your input';
    s.waitingSince = now;
  } else if (evtName === 'stop' || evtName.includes('stop')) {
    s.needsAttention = true;
    s.attentionReason = 'Finished — your turn';
    s.waitingSince = now;
  } else if (
    evtName.includes('userpromptsubmit') || evtName.includes('pretooluse') ||
    evtName.includes('posttooluse') || evtName.includes('sessionstart') ||
    ev.type === 'tool_start' || ev.type === 'tool_end'
  ) {
    // agent is active again — clear the alert
    s.needsAttention = false;
    s.attentionReason = null;
    s.waitingSince = null;
  } else if (evtName.includes('sessionend')) {
    s.needsAttention = false;
    s.attentionReason = null;
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
      if (s.needsAttention) { s.needsAttention = false; s.attentionReason = null; saveState(); broadcast(); }

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
    const lnk = path.join(startupDir, 'AI HQ.lnk');
    const reply = (obj, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

    if (req.method === 'GET') {
      if (process.platform !== 'win32') return reply({ ok: true, supported: false, enabled: false });
      return reply({ ok: true, supported: true, enabled: fs.existsSync(lnk) });
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
            if (err) return reply({ ok: false, enabled: fs.existsSync(lnk), error: (stderr || err.message || '').trim() }, 500);
            reply({ ok: true, enabled: fs.existsSync(lnk), result: (stdout || '').trim() });
          });
      });
      return;
    }
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
  if (urlPath === '/') urlPath = '/index.html';
  else if (urlPath === '/dashboard' || urlPath === '/dashboard/') urlPath = '/dashboard.html';
  else if (urlPath === '/history' || urlPath === '/history/') urlPath = '/history.html';
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
|                AI HQ SERVER v2                   |
+--------------------------------------------------+
  Office:     http://localhost:${PORT}
  Dashboard:  http://localhost:${PORT}/dashboard
  Network:    http://${localIP}:${PORT}
  Sessions:   GET  http://localhost:${PORT}/sessions
  Events:     POST http://localhost:${PORT}/event

Waiting for Claude Code events...`);
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
