# Spatial Design Canvas (`spatial-design-canvas`)

Standalone, repository-agnostic **spatial live-code design canvas** — an AI-compatible work surface (human + agent, shared graph). North star is [GitHub Copilot Canvas Extensions](https://docs.github.com/en/copilot/how-tos/github-copilot-app/working-with-canvas-extensions). Until that host is in play, the daily driver is a **local webapp** in this repo; Cursor MCP Apps remain an inline adapter only.

See [`PLAN.md`](./PLAN.md) for Now / Next / Later, the decision log, and sprint details.

## Two-Repository Layout

- **Design Tool (this repo):** `~/Workspace/typescript/spatial-design-canvas`
- **Target Banking MFE Testbed:** `~/Workspace/angular/mock-bank-mfe`

## Hosts

| Host | Role | How to open |
| :--- | :--- | :--- |
| **Local webapp** | Daily driver (full viewport) | `npm run dev` → [http://127.0.0.1:4173](http://127.0.0.1:4173) |
| **Cursor MCP App** | Inline chat widget adapter | Global `~/.cursor/mcp.json` + `open_design_canvas` |
| **GitHub Copilot Canvas** | Target at work (Sprint 10) | `createCanvas({ open })` → same `http://127.0.0.1:4173` URL |

Agent mutations (MCP tools or HTTP) share `.design-canvas.json` in the target repo. The webapp listens via SSE (+ file watch) so agent edits appear without reload. Focus-mode **canvas → agent** edits use `@cursor/sdk` against the target repo (`POST /api/edit`).

## Quick Start (Sprint 8)

For **meso** stills, **module rails**, **screen focus**, **fixture satellites**, and the **edit composer** you need **both** repos running. Meso capture uses Playwright against your installed **Google Chrome** (`channel: 'chrome'`). Canvas-initiated edits need a Cursor API key in `.env`.

```bash
# Terminal A — Nordhavn Bank (shell :4200 + MFEs)
cd ~/Workspace/angular/mock-bank-mfe
npm run dev

# Terminal B — Spatial Design Canvas
cd ~/Workspace/typescript/spatial-design-canvas
cp .env.example .env   # set CURSOR_API_KEY=
export DESIGN_CANVAS_TARGET=~/Workspace/angular/mock-bank-mfe
# optional: export DESIGN_CANVAS_APP_ORIGIN=http://localhost:4200
npm install
npm run typecheck
npm run build
npm run dev
```

Then open **http://127.0.0.1:4173**.

- UI (Vite): `127.0.0.1:4173` — proxies `/api` → API
- Agent API: `127.0.0.1:4174` — JSON + SSE + snapshot capture + Cursor SDK edits
- Bank shell: `localhost:4200` — capture target for meso stills; live iframe for focused workspace

### Overview levels

| Level | Behavior |
| :--- | :--- |
| **Node view** (`macro`) | Topology cards (title, route, MFE). No mounts. |
| **Live preview** (`meso`) | Larger nodes with **cached WebP stills** (3× device scale by default — sharp through high canvas zoom). Skeleton first, then image. Captured sequentially by Playwright; on-camera nodes first, then idle prefetch. Module boxes fit their `frame`. No overview iframes. |

### Node kinds

| Kind | Visible in overview | Focus | Notes |
| :--- | :--- | :--- | :--- |
| **`screen`** | Yes | Full-page workspace (default 1280×800) | Destinations (`/`, `/transfer`, `/profile`, …) |
| **`module`** | Yes | Workspace uses that node’s `frame` | Chrome/slots (nav rail). `previewPath` is a canvas-only shell mount such as `/__canvas/module/nav` |
| **`fixture`** | Hidden | Satellite variants of the parent screen | `parentId` + `?fixture=` |

Edges are `kind: "flow"` (in-product) or `kind: "nav"` (menu → destination). Missing kind normalizes to `flow`.

### Dragging nodes

Click and drag a screen or module to reposition it. Edges stay attached. Drop persists via `POST /api/nodes/move`.

### Screen focus

Double-click a screen or module (from node view or live preview) to **lift** it onto a new almost-fullscreen canvas (the original flow stays underneath, scrimmed). The node sits on that new canvas — it does not become the modal itself. Node view | Live preview is disabled. Focusing the nav module lifts a **rail-shaped** workspace.

- **Back to overview** (top-left) or click the scrim around the new canvas exits (slow reverse).
- **Escape** exits when the canvas chrome has focus (if the iframe stole keyboard focus, use Back).
- Overview level and camera are restored; they are not overwritten while focused.

### Edit composer (canvas → agent)

While a screen or module is focused, a composer docks at the bottom of the viewport. Type what should change and **Send** (or ⌘/Ctrl+Enter). The API runs a durable local Cursor SDK agent against `DESIGN_CANVAS_TARGET` with the focused node’s `mfe` / `route` / `previewPath` in the prompt. Follow-ups keep context; **New** starts a fresh agent. The focused iframe’s HMR is the reflection — there is no reverse MCP into the IDE chat.

Requires `CURSOR_API_KEY` in `.env` (see `.env.example`). Missing key → `503` from `/api/edit`.

### Edge-case fixtures

Fixture nodes (`kind: "fixture"`) are children of a screen (`parentId` + `fixture` key). They stay **hidden in the overview**. While a screen (or one of its fixtures) is focused, **Default + fixtures** appear as full-size variants on the modal canvas — pan with scroll or Space-drag, zoom with Cmd/Ctrl+scroll (trackpad pinch), reset with Cmd/Ctrl+0. Floating titles: **screen title** in overview, **variant name** in focus. Macro badges still show the owning MFE.

- Click a variant (or `focus_node` / `POST /api/focus` with the fixture id) to make that iframe interactive.
- Each fixture stores a concrete `previewPath` with `?fixture=<key>` (e.g. `/accounts/everyday?fixture=empty_transactions`). `mock-bank-mfe` reads the query and alters data/UI.
- Seed fixtures: accounts-list (`empty_accounts`, `api_timeout`); account-detail (`empty_transactions`, `insufficient_funds`, `api_timeout`); transfer-amount (`insufficient_funds`); transfer-confirm (`processing`); transfer-done (`error`).

Legacy documents with `"semanticZoomLevel": "micro"` are coerced to `meso` on load.

```bash
# enter / exit focus
curl -s -X POST http://127.0.0.1:4174/api/focus \
  -H 'content-type: application/json' \
  -d '{"nodeId":"accounts-list"}' | jq .view

# focus a fixture state directly
curl -s -X POST http://127.0.0.1:4174/api/focus \
  -H 'content-type: application/json' \
  -d '{"nodeId":"account-detail--insufficient_funds"}' | jq .view

curl -s -X PATCH http://127.0.0.1:4174/api/view \
  -H 'content-type: application/json' \
  -d '{"focusedNodeId":null}' | jq .view

# switch overview level
curl -s -X PATCH http://127.0.0.1:4174/api/view \
  -H 'content-type: application/json' \
  -d '{"semanticZoomLevel":"meso"}' | jq .view
```

```bash
# list graph + config
curl -s http://127.0.0.1:4174/api/canvas | jq .
curl -s http://127.0.0.1:4174/api/config | jq .

# add a screen node
curl -s -X POST http://127.0.0.1:4174/api/nodes \
  -H 'content-type: application/json' \
  -d '{"id":"transfer","title":"Transfer","route":"/transfer","mfe":"accounts-mfe","x":760,"y":120}'

# add a fixture child of a screen
curl -s -X POST http://127.0.0.1:4174/api/fixtures \
  -H 'content-type: application/json' \
  -d '{"id":"account-detail--custom","parentId":"account-detail","title":"Custom empty","fixture":"empty_transactions","previewPath":"/accounts/everyday?fixture=empty_transactions"}'

# add a module node (nav rail)
curl -s -X POST http://127.0.0.1:4174/api/modules \
  -H 'content-type: application/json' \
  -d '{"id":"nav-rail","title":"Nav","route":"/__canvas/module/nav","mfe":"nav-mfe","x":40,"y":80,"previewPath":"/__canvas/module/nav","frame":{"width":280,"height":800}}'
```

### MCP App (inline Cursor adapter)

```bash
DESIGN_CANVAS_TARGET=~/Workspace/angular/mock-bank-mfe npm run start:mcp
```

Register in **`~/.cursor/mcp.json`** (project-scoped MCP Apps may not mount `ui://` widgets):

```json
{
  "mcpServers": {
    "spatial-design-canvas": {
      "command": "node",
      "args": [
        "/Users/patrickjessen/Workspace/typescript/spatial-design-canvas/dist/mcp/main.js"
      ],
      "env": {
        "DESIGN_CANVAS_TARGET": "/Users/patrickjessen/Workspace/angular/mock-bank-mfe",
        "DESIGN_CANVAS_APP_ORIGIN": "http://localhost:4200"
      }
    }
  }
}
```

### Copilot mapping (Sprint 10 — not implemented yet)

When packaging as a Copilot Canvas Extension:

- `open()` → `{ url: "http://127.0.0.1:4173" }` (this webapp)
- Canvas actions → the same operations as `/api/*` / MCP tools
- Canvas → agent edits → map `/api/edit` to `session.send`
- State → target repo `.design-canvas.json`

## Module Layout

- `PLAN.md` — Living plan (Now / Next / Later, decision log, sprint board)
- `src/types/` — Core canvas domain types + Zod schemas
- `src/store/` — `.design-canvas.json` read/write store
- `src/actions/` — Shared `CanvasActions` + in-process event bus
- `src/mcp/` — Cursor MCP App adapter (`ui://design-canvas`)
- `src/web/` — HTTP agent API + SSE + `/api/config` + snapshot capture + Cursor SDK edit agent
- `src/canvas/` — Host-agnostic renderer + MCP / web host clients + focus edit composer
- `src/adapters/` — `ViewportNode`, `SnapshotAdapter`, `WebIframeAdapter`, stub `NativeStreamAdapter`
- `src/preview/` — `previewPath` / `appOrigin` helpers + Playwright `SnapshotService`
- `skills/` — *(Sprint 11)* Portable `SKILL.md` structural exploration workflow

## Agent API

| Surface | Operation |
| :--- | :--- |
| `GET /api/canvas` / `list_canvas` | Read document |
| `GET /api/config` | `{ appOrigin, sprint, editConfigured }` for mounts / capture |
| `GET /api/snapshots` | Capture or return cached 2× WebP (`path`, `w`, `h`, `scheme`) |
| `POST /api/snapshots/invalidate` | Drop the in-memory snapshot cache |
| `POST /api/nodes` / `add_screen_node` | Add screen node |
| `POST /api/fixtures` / `add_fixture_node` | Add fixture child of a screen |
| `POST /api/modules` / `add_module_node` | Add module (chrome/slot) node with optional `frame` |
| `POST /api/select` / `select_node` | Select / clear node |
| `POST /api/focus` / `focus_node` | Enter / exit focused workspace (screen, module, or fixture) |
| `POST /api/nodes/move` / `move_node` | Move a screen or module node (edges stay attached) |
| `PATCH /api/view` / `update_view` | Persist pan/zoom / focus / semantic zoom |
| `POST /api/edit` | Canvas → Cursor SDK edit (`prompt`, optional `nodeId`) |
| `POST /api/edit/cancel` | Cancel the in-flight edit run |
| `POST /api/edit/reset` | Drop the durable edit agent (New) |
| `GET /api/events` | SSE `document` + `edit` stream |
| `open_design_canvas` | MCP-only — open inline UI |

State lives in the target repo at `.design-canvas.json`. Nodes may set `previewPath` (e.g. `/accounts/everyday` or `/accounts/everyday?fixture=empty_transactions`) when `route` is parameterized.
