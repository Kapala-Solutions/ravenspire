# AI HQ — Claude Code Control Panel

Real-time mission control for **every Claude Code session on your machine** — CLI, VS Code, and Claude Desktop, all at once. See who's working, what they're doing, what it's costing in API tokens, and what that work is *worth* in labor value — in a live dashboard, a pixel-art office, and a historical archive.

![AI HQ Control Panel](aihq-dashboard.png)

> **This is a heavily extended fork.** It started as a pixel-office toy (see [Credits](#credits--inspiration)) and grew into a full control panel: cost & labor accounting, session grouping into teams, a history view with trend charts, cowork capture, and an installable desktop app (PWA).

---

## ✨ What this fork adds over the original

The original AI HQ was a pixel office with one character per session. This version keeps that **and** layers on a real control panel:

| Area | Added |
| --- | --- |
| **Control Panel** (`/dashboard`) | Rich per-session cards: persona name, live activity line, model, IDE, token breakdown (in/out/cache), API cost + cost breakdown, message count, uptime |
| **Session grouping** | Sessions from the same workspace (host + IDE + folder) collapse into expandable **team cards** with aggregate tokens/cost/labor — no more 8 cards for one project |
| **Status filter & triage** | Toggle the board by status — **Working / Waiting / Idle** — and one-click **Archive old** to sweep stale idle sessions off the board (kept in History) |
| **Instant view switching** | An app shell keeps office, panel, and history mounted and live — toggling views is instant, WebSockets stay connected, office characters keep their desks. Card avatars jump straight to that agent in the office with a 📍 pin |
| **⚔️ Guild of Agents (RPG)** (`/rpg`) | A full JRPG view of the same data: every session is a **hero** (class from role, level/XP from tokens), their task is a **quest**, working = **battling a monster** whose tier scales with the task (slime → goblin → golem → dragon), tool calls land as attacks in a live **battle log**, waiting agents kneel with a "!" — plus gold (labor) & mana (tokens) HUD, quest log, splash screen, and a CRT scanline toggle |
| **History** (`/history`) | Lifetime stat tiles, SVG trend charts (tokens / cost / sessions over time), and a sortable **per-session archive** that survives clearing the board |
| **Cost & labor accounting** | Infers a role per session → salary → hourly rate → **labor value** from active work time; API cost estimated from the transcript |
| **"Needs you" alerts** | Pulsing banner, chime, OS notification, and tab-title badge when an agent finishes or asks for input (with mute) |
| **Click-to-focus** | Click a card to bring that session's terminal/IDE window to the front; Claude Desktop sessions open via `claude://resume` deep link |
| **Two ingestion paths** | Hook-based capture for Claude **Code**, plus a log watcher for Claude Desktop **cowork** sessions (incl. VM sessions that can't post back). A `code` / `cowork` badge marks each |
| **Installable app (PWA)** | Custom favicon/icons, web app manifest, service worker (offline app shell), and app shortcuts — install it as a standalone desktop window |
| **Settings** | In-app gear: **Start with Windows** toggle (wires the autostart scripts) and **Install as app** |
| **Quality-of-life** | Rename any session, reassign its role, persona names that never collide, a stale-session sweep, and network access from other machines |

---

## 📸 Screenshots

### Control Panel — grouped team cards, live cost & labor
![Control Panel](aihq-dashboard.png)

### History — trends over time + per-session archive
![History](aihq-history.png)

### ⚔️ Guild of Agents — the RPG view (`/rpg`)
Heroes battle project monsters while tool calls stream into the battle log. Priya (Lv.31) is fighting *the ai-hq Dragon*; Lola casts *Terminal Incantation* on a Golem.
![Guild of Agents RPG](aihq-rpg.png)

### Pixel Office — the original real-time office view (`/`)
![Pixel Office](screenshot.png)

---

## 🚀 Quick start

### 1. Install & run

```bash
npm install
node server.js
```

The server listens on **http://localhost:3456** (and prints your network URL). It serves four views inside a persistent app shell:

| URL | View |
| --- | --- |
| `/` | **App shell** — office, panel, and history all stay mounted and live; switching is instant (no reloads). Office shows first; `/#panel` and `/#history` deep-link the other tabs |
| `/office` | Pixel-art office (standalone) |
| `/dashboard` | Control panel (standalone) |
| `/history` | Trends + session archive (standalone) |
| `/rpg` | ⚔️ Guild of Agents — RPG quest view (standalone; `/#rpg` inside the shell) |

### 2. Wire up Claude Code hooks

Add these to `~/.claude/settings.json` so every Claude Code session reports in. Replace the path with wherever this repo lives:

```jsonc
{
  "hooks": {
    "SessionStart":     [{ "hooks": [{ "type": "command", "command": "powershell -NoProfile -ExecutionPolicy Bypass -Command \"& '<AI_HQ_PATH>/send-event.ps1' -Type SessionStart     -Server 'http://127.0.0.1:3456'\"" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "powershell -NoProfile -ExecutionPolicy Bypass -Command \"& '<AI_HQ_PATH>/send-event.ps1' -Type UserPromptSubmit -Server 'http://127.0.0.1:3456'\"" }] }],
    "PreToolUse":       [{ "matcher": ".*", "hooks": [{ "type": "command", "command": "powershell -NoProfile -ExecutionPolicy Bypass -Command \"& '<AI_HQ_PATH>/send-event.ps1' -Type PreToolUse  -Server 'http://127.0.0.1:3456'\"" }] }],
    "PostToolUse":      [{ "matcher": ".*", "hooks": [{ "type": "command", "command": "powershell -NoProfile -ExecutionPolicy Bypass -Command \"& '<AI_HQ_PATH>/send-event.ps1' -Type PostToolUse -Server 'http://127.0.0.1:3456'\"" }] }],
    "Stop":             [{ "hooks": [{ "type": "command", "command": "powershell -NoProfile -ExecutionPolicy Bypass -Command \"& '<AI_HQ_PATH>/send-event.ps1' -Type Stop         -Server 'http://127.0.0.1:3456'\"" }] }],
    "Notification":     [{ "hooks": [{ "type": "command", "command": "powershell -NoProfile -ExecutionPolicy Bypass -Command \"& '<AI_HQ_PATH>/send-event.ps1' -Type Notification -Server 'http://127.0.0.1:3456'\"" }] }],
    "SessionEnd":       [{ "hooks": [{ "type": "command", "command": "powershell -NoProfile -ExecutionPolicy Bypass -Command \"& '<AI_HQ_PATH>/send-event.ps1' -Type SessionEnd   -Server 'http://127.0.0.1:3456'\"" }] }]
  }
}
```

`send-event.ps1` reads the hook payload from stdin (real session id, cwd, transcript path, tool target, notification message, IDE) and POSTs it to the server. Because these hooks live in the **global** settings file, every IDE and CLI session is covered automatically. Restart Claude Code after adding them.

### 3. (Optional) Start with Windows & install as an app

- Open **⚙ Settings** in the panel and flip **Start with Windows** — or run `install-autostart.ps1` directly. It drops a hidden launcher in your Startup folder.
- Click **Install as app** (or your browser's install button) to run AI HQ as a standalone desktop window.

---

## 🧠 How it works

```
Claude Code hooks ─┐
(send-event.ps1)   │
                   ├──▶  server.js (:3456)  ──▶  WebSocket  ──▶  /  · /dashboard · /history
Claude Desktop     │        · session store          broadcast
main.log watcher ──┘        · transcript parse (tokens/cost/model)
(desktop-watcher.js)        · role → labor value
                            · history.csv + sessions-history.jsonl
```

- **Two sources feed one store.** Claude Code fires hooks; Claude Desktop **cowork** sessions (which may run in a VM that can't reach the host) are picked up by tailing the desktop app's `main.log`. Sessions merge by id and carry a `code` / `cowork` source badge.
- **The server is authoritative.** It parses each session's transcript for accurate tokens/cost/model, assigns a stable persona, computes a live activity line, and persists state.
- **History is durable.** Aggregate snapshots append to `history.csv`; every finished (or cleared) session is archived to `sessions-history.jsonl` so nothing is lost.

---

## ⚙️ Configuration — `config.json`

```jsonc
{
  "port": 3456,
  "autoStart": true,
  "staleMinutes": 15,      // mark a quiet session "idle" after N minutes
  "abandonMinutes": 45,    // drop a stuck "needs you" alert after N minutes
  "watchDesktop": true     // set false to disable the cowork log watcher
  // "desktopLogPath": "…" // override the Claude Desktop main.log location
}
```

The port can also be overridden with the `PORT` environment variable.

---

## 🔌 HTTP API

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/sessions` | All sessions (JSON) |
| `GET` | `/history.csv` | Aggregate time-series |
| `GET` | `/history/sessions` | Per-session archive + live sessions (merged, deduped) |
| `GET` | `/roles` | Role list + salary table |
| `GET` | `/autostart` · `POST` `/autostart` | Read / toggle "Start with Windows" |
| `POST` | `/event` | Hook event ingestion |
| `POST` | `/focus` | Bring a session's window to front |
| `POST` | `/rename` · `/role` · `/clear` | Rename, set role, clear sessions |

---

## Credits & Inspiration

Built upon [**jaysonbrush/ai-hq**](https://github.com/jaysonbrush/ai-hq) — huge thanks to Jayson for the original AI HQ implementation this control panel grew from.

The original AI HQ was itself inspired by [PixelHQ](https://www.reddit.com/r/ClaudeCode/comments/1qrbsfa/i_built_a_pixel_office_that_animates_in_realtime/) by [u/Waynedevvv](https://www.reddit.com/user/Waynedevvv/) — a mobile app that does the same concept on your phone. Check out the original if you want a native iOS experience!
