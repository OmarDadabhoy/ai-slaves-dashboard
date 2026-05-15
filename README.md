# AI Slaves Power Doc

Local ticketing dashboard. Power version of the Google Doc.

The /ai-slaves drain still owns the Google Doc as canonical source of truth. This app mirrors every drain write in parallel so you get a real UI without giving up the SKILL-only architecture.

## Sections

- **Tickets**: board view with queued / in_progress / blocked / done lanes. List view available. Filter by `all / next drain / from dashboard`. Sort by created / cycle / status.
- **Suggested Changes**: revenue-led suggestions from drains. `Promote to ticket` button creates a queued ticket in one click. `Drop` archives.
- **Follow-up**: open decisions with radio-style option pickers. Decided ones collapse into an archive accordion.
- **Agents**: live + recently-completed sub-agents the orchestrator spawns. Read-only for now. Reads `data/agents.json`.
- **Recently Done**: last 12 closed tickets.

Auto-refreshes every 5 seconds so orchestrator writes appear without a reload.

## Install + Run

One-command launch (recommended):

```
cd ~/Desktop/Ai-slaves-dashboard
npm run app
```

`npm run app` runs `scripts/start.sh`, which: installs deps if needed, frees conflicting ports, starts the dev server in the background, and opens `http://localhost:5179/` in your default browser.

Stop:

```
npm run stop
```

Manual:

```
npm install
npm run dev
```

## Ports

- 5179: Vite (React UI). Pinned via `strictPort: true`. Fails loudly if taken.
- 5176: Express API. Bound to 127.0.0.1.

If 5179 is busy, `start.sh` will kill the holder. To override, edit `vite.config.js`. Express picks up `PORT` / `HOST` env vars.

## Adding a ticket

Type in the bar at the top, hit Enter. That POSTs to `/api/tasks` with `status=queued`. From there you can move it through the board, flag `assign next drain` (the orchestrator can read that flag and pick up flagged tickets on its next run), or delete.

## API

`server.js` is a tiny REST layer. Source of truth: `./data/*.json`.

| Method | Path | Effect |
| --- | --- | --- |
| GET / POST | `/api/tasks` | List / create tickets |
| PATCH / DELETE | `/api/tasks/:id` | Update / delete |
| GET / POST | `/api/suggested_changes` | List / create SCs |
| PATCH / DELETE | `/api/suggested_changes/:id` | Update / delete |
| POST | `/api/suggested_changes/:id/promote` | One-shot: promote SC into a queued ticket, mark SC promoted |
| GET / POST | `/api/followups` | List / create |
| PATCH / DELETE | `/api/followups/:id` | Update decision / delete |
| GET / POST | `/api/done_log` | List / create |
| GET / POST | `/api/agents` | List / create agent rows |
| PATCH / DELETE | `/api/agents/:id` | Update / delete |
| GET | `/api/health` | `{"ok": true}` |

Back-compat: `status=todo` (old) is treated as `queued` (new) on read.

## How the orchestrator uses this

AI Slaves stays a SKILL (no Claude Agent SDK). The drain detects this server at start:

```bash
curl -sf --max-time 2 http://127.0.0.1:5176/api/health >/dev/null && DASH_MIRROR=1
```

If reachable, it POSTs claim rows, PATCHes status on done, and POSTs per-cycle Suggested Changes / Follow-up / Done entries here in parallel with the Google Doc writeback. Dashboard offline = silent skip. Doc is the only required path.

See `~/Desktop/Ai-slaves/skills/get-shit-done/SKILL.md`, section `Dashboard mirror (optional)`.

## Agents panel data shape

The orchestrator will write rows like this to `data/agents.json` once cycle 16 wires it up:

```json
{
  "id": "ag-001",
  "agentId": "agent-43f1",
  "drain_cycle_id": 15,
  "task_title": "Build ticketing power-doc dashboard upgrade",
  "status": "running",
  "spawned_at": "2026-05-15T18:42:00Z",
  "completed_at": null
}
```

Status `running` shows in the live list. Any other status (e.g. `completed`) drops into the recent archive.

## Build

```
npm run build
```

Outputs static assets in `dist/` if you want to serve from any static host.

## Why not Electron

Considered, skipped. Launcher script gets you single-command "open the dashboard" without packaging, signing, or eating 100+ MB. `npm run app` is the app icon. Revisit if you want a menu-bar surface or push notifications.
