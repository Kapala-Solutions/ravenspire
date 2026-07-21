# AI HQ v2 — Agent Control Panel (Design)

Date: 2026-07-20
Status: Approved

## Goal

Evolve `ai-hq` from a flaky pixel-office toy into an accurate control panel for
every Claude Code session running across all surfaces (CLI, desktop, VS Code).

**Acceptance test:** the session we are working in right now appears in the panel
with the correct session id, model, IDE, a live-ticking uptime, and a token count
that matches its transcript.

## Problem with v1

- `send-event.ps1` discards the real `session_id` and uses `MD5(hostname+cwd)`,
  so sessions in the same folder collide and can never be matched to a transcript.
- Only PreToolUse/PostToolUse exist — no lifecycle, so no start time and sessions
  never accurately go idle or leave.
- No tokens, no time, no model, no IDE distinction.

All of this is fixable: the hook stdin payload already carries `session_id`,
`cwd`, `transcript_path`, `hook_event_name`; and the transcript `.jsonl` already
carries per-message `usage` (tokens) and `model`.

## Data model (server-authoritative, one per session)

| Field | Source |
|---|---|
| `sessionId` | real `session_id` from hook stdin |
| `name` | custom rename → first user-prompt snippet → folder name |
| `model` | parsed from `transcript_path` |
| `ide` | `CLAUDE_CODE_ENTRYPOINT` / `TERM_PROGRAM` → cli · vscode · desktop |
| `project`, `cwd` | hook payload |
| `state` | starting · working · thinking · idle · ended |
| `startTime`, `uptime` | `SessionStart`; uptime ticks client-side |
| `tokens{input,output,cacheCreation,cacheRead}`, `cost` | summed from transcript |
| `currentTool`, `toolCount` | Pre/PostToolUse |
| `lastActivity` | any event |

## Components (isolated units)

1. **`send-event.ps1`** — reads full hook JSON from stdin, augments with IDE env
   detection, POSTs the whole payload to the server. Dumb and fast; no parsing
   logic beyond forwarding.
2. **`server.js`** — authoritative session store (Map). On each event: upsert
   session, drive the state machine, and if `transcript_path` is present, parse
   the transcript to compute accurate tokens/cost/model/name. Persists the store
   to `sessions.json` (survives restart). Exposes `GET /sessions` and broadcasts
   the full enriched list over WebSocket.
3. **`transcript.js`** — pure helper: given a transcript path, return
   `{tokens, model, firstPrompt}`. Testable in isolation.
4. **`dashboard.html`** (served at `/dashboard`) — control panel: one card per
   session with name, model badge, IDE badge, live state dot, ticking uptime,
   tokens, est. cost, current tool. Links to the office.
5. **`index.html`** (office, served at `/`) — unchanged behavior; gains a link to
   the dashboard.

## Hooks (global `~/.claude/settings.json`)

Add `SessionStart`, `UserPromptSubmit`, `Stop`, `SessionEnd` alongside the
existing Pre/PostToolUse, all calling `send-event.ps1 -Type <event>`. Because all
IDEs read this one file, every surface is covered automatically.

## State machine

- `SessionStart` → `starting`, set `startTime`
- `UserPromptSubmit` → `working`
- `PreToolUse` → `working`, set `currentTool`, `toolCount++`
- `PostToolUse` → `working`, clear `currentTool`
- `Stop` → `idle`
- `SessionEnd` → `ended` (card retained for history)

## Delivery

- **Milestone A** — ingestion + server + minimal dashboard render. Verified by
  replaying this session's real payload so its card shows correct data.
- **Milestone B** — polished dashboard cards + office/dashboard toggle.

## Non-goals (for now)

- Auth / multi-user. Local network only.
- Historical charts over time (data is persisted; charts are a later iteration).
- Controlling/steering agents from the panel (view-only for now).
