# Ravenspire — rebrand, GitHub page branding & donations

**Date:** 2026-07-22
**Status:** Approved by owner (name, positioning, scope, donation setup)
**Supersedes:** the "AgentQuest" product name introduced in v2.0.0

## Why

Market research (deep-research run, 2026-07-22, 104 agents / 22 sources, claims adversarially
verified) found a direct naming collision: **FulAppiOS/Agent-Quest**, a free MIT gamified
dashboard for Claude Code + Codex agents in a medieval fantasy setting — one hyphen away from
"AgentQuest" and built on the same agents-as-fantasy-heroes metaphor. Four more free pixel-art
agent viewers (AgentRoom, PixelHQ, claude-office, claude-hq) crowd the same vocabulary space
("agent", "quest", "HQ", "office"). The research recommendation: rename before any public push,
and market the ops layer (cost/labor analytics, response-time tracking, notifications) rather
than the pixels.

## 1. Identity

**New name: Ravenspire.**

The tower where the ravens roost. In fantasy canon, ravens *are* the messaging system: agents
are out in the field and every status change is a raven flying back to the spire. The metaphor
maps one-to-one onto the product's verified differentiators:

| Lore | Feature |
| --- | --- |
| A raven flies to the spire | Native toasts + ntfy/Telegram/webhook phone push |
| How fast you answer the raven | Response-time analytics (wait→response log) |
| The rookery's records | Durable per-session history + trend charts |
| The view from the spire | Control panel: cost, labor value, live activity |

**Availability (all verified 2026-07-22):**

- npm `ravenspire` — free (registry returns 404)
- `ravenspire.dev` — unregistered (Google Registry RDAP 404)
- `ravenspire.com` — taken by an unrelated small capital firm; low confusion risk, we lead with `.dev`
- GitHub — one empty 0-star repo (`Jake1848/ravenspirecapital`); no product collision
- Clean distance from every named competitor: no "agent", "quest", "HQ", or "office" in the name

**In-game vocabulary is unchanged** (guild, heroes, quests, world boss, tavern). This is a
name-only rebrand; the game world is genre vocabulary, not brand.

## 2. Positioning & copy

- **One-liner (README h1):** *Ravenspire — mission control for your AI agents, as a JRPG.*
- **Tagline:** *"When an agent needs you, a raven flies."*
- **Positioning:** the only agent dashboard pairing a real ops layer — cost & labor-value
  accounting, response-time analytics, durable history, native + phone push — with a game
  world you actually want to look at. Marketing leads with the ops layer; the pixels are the charm.
- Agent coverage now includes Claude Code, Claude Desktop cowork, and OpenAI Codex sessions —
  copy says "your AI agents", not "your Claude agents".

## 3. Rebrand scope & migration

Brand strings live in 13 files. Changes:

| Surface | Change |
| --- | --- |
| `package.json` | `name`: `agentquest` → `ravenspire`; description → new one-liner |
| `README.md` | full re-lead (see §4); title, taglines, clone URL |
| `app.html`, `rpg.html`, `dashboard.html`, `history.html` | page `<title>`s, header wordmarks, brand strings |
| `manifest.webmanifest` | PWA `name`/`short_name` → Ravenspire |
| `sw.js` | brand string + **bump cache key** so installed PWAs refresh |
| `notify.ps1` | toast application title |
| `install-autostart.ps1` / `uninstall-autostart.ps1` | scheduled-task name → Ravenspire; uninstall (and install, before re-creating) must **also remove the old AgentQuest task** so existing users don't strand an autostart entry |
| `server.js`, `setup-hooks.js` | console banners / log branding |
| GitHub repo | rename to `Kapala-Solutions/ravenspire` (GitHub auto-redirects old URLs) |

**Owner-only actions (not automatable):** register `ravenspire.dev`; publish a placeholder
to npm to reserve the name; rename the GitHub repo; set repo description/topics/social image
(assets provided by this project, upload is manual).

**Out of scope:** replacing the app icon set (a raven mark is the obvious v-next follow-up);
re-theming any in-game vocabulary.

## 4. GitHub page branding

Visual identity — matches the product's 16-bit night-time world:

- **Palette:** midnight navy `#0b0e1a`, raven black `#14161f`, moonlit silver `#c8d0e0`,
  arcane violet accent `#8b7cf6`, ember highlight `#e8a33d` (windows/lantern light)
- **Hero banner:** committed SVG (`docs/brand/ravenspire-banner.svg`), pixel-art style —
  raven silhouette on a spire against a moon, "RAVENSPIRE" wordmark in blocky pixel
  lettering, tagline beneath. SVG keeps the zero-build ethos (no image pipeline) and renders
  crisply in the README at any width.
- **Social preview:** 1280×640 PNG rendered from the banner art
  (`docs/brand/ravenspire-social.png`) for the repo's Settings → Social preview slot.
- **README layout (top to bottom):**
  1. Centered hero banner
  2. Italic tagline line
  3. Badge row: MIT license · Node ≥ 18 · PRs welcome · 🍺 Buy me a beer
  4. Three-sentence pitch (ops layer first, game second)
  5. Full-width quest-world screenshot; control panel + history screenshots side by side
  6. Existing sections (features table, quick start, views, how it works, config, API,
     platform notes, contributing) carried over with brand strings swapped
  7. **Support section** (see §5) above License & credits
- **Screenshot assets:** rename `aihq-rpg.png` / `aihq-dashboard.png` / `aihq-history.png` →
  `ravenspire-*.png` and update README references — the public repo should not ship
  previous-brand filenames.
- **Repo metadata (manual):** description = one-liner; topics: `claude-code`, `codex`,
  `ai-agents`, `dashboard`, `monitoring`, `observability`, `pixel-art`, `jrpg`, `nodejs`, `pwa`.

## 5. Donations — "Buy me a beer" 🍺

- **Platform:** Buy Me a Coffee, presented as "Buy me a beer".
- **README:** badge in the top badge row + a Support section with the standard BMC button
  image linking to `https://buymeacoffee.com/BMC_USERNAME_PLACEHOLDER`, and one line of
  thanks copy in the project's voice ("Ravens fly on beer money.").
- **`.github/FUNDING.yml`:** `buy_me_a_coffee: BMC_USERNAME_PLACEHOLDER` — enables GitHub's
  native Sponsor button pointing at the same page.
- **Placeholder contract:** `BMC_USERNAME_PLACEHOLDER` is used consistently in exactly these
  two files so the real username is a single find-and-replace once the owner creates the
  account at buymeacoffee.com (~2 minutes). Launch checklist includes this swap; the button
  must not ship to a public audience with the placeholder live.
- Donations stay a tip jar, consistent with the market research verdict: free/MIT is the
  distribution strategy; no paywall.

## Success criteria

1. `git grep -i agentquest` returns only historical references (CHANGELOG-style/spec docs),
   zero hits in runtime code, manifest, scripts, or README.
2. Fresh `npm run setup && npm start` shows Ravenspire branding in console, browser tab,
   PWA install prompt, and Windows toasts.
3. Existing users upgrading in place get the new autostart task and the old AgentQuest task
   removed; installed PWAs refresh to the new name via the bumped service-worker cache key.
4. README renders with banner, badges, screenshots, and a working Sponsor/BMC button
   (post username swap).
