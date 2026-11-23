# Vista Canvas (`vista-canvas`)

Standalone, repository-agnostic **design canvas** — an AI-compatible work surface (human + agent, shared graph) for mapping a running app’s screens, flows, and states.

**Current scope:** map a **running host app** (MFEs may load from CDN at runtime) and present that map in [GitHub Copilot Canvas Extensions](https://docs.github.com/en/copilot/how-tos/github-copilot-app/working-with-canvas-extensions). See [`PLAN.md`](./PLAN.md).

Until Copilot is the daily driver, use the **local webapp** in this repo. Cursor MCP Apps remain an inline adapter only.

## Two-Repository Layout

- **Design Tool (this repo):** `~/Workspace/typescript/vista-canvas`
- **Target app (testbed):** `~/Workspace/angular/mock-bank-mfe`

State lives in the **target** repo as `.design-canvas.json`. The canvas never needs MFE source on disk to preview — iframes and Playwright hit the **host shell** (`DESIGN_CANVAS_APP_ORIGIN`); remotes load inside that host.

## Hosts

| Host | Role | How to open |
| :--- | :--- | :--- |
| **Local webapp** | Daily driver (full viewport) | `npm run dev` → [http://127.0.0.1:4173](http://127.0.0.1:4173) |
| **Copilot Canvas** | Work target | Open this repo in Copilot → **Vista Canvas** (`.github/extensions/…`) |
| **Cursor MCP App** | Inline chat widget adapter | Global `~/.cursor/mcp.json` + `open_design_canvas` |

Agent mutations (MCP tools, Copilot actions, or HTTP) share `.design-canvas.json`. The webapp listens via SSE (+ file watch) so agent edits to the graph appear without reload.

## Quick Start (local mock bank)

For **meso** stills, **Map**, **module rails**, **screen focus**, and **fixture satellites** you need **both** repos running. Capture and mapping use Playwright against installed **Google Chrome** (`channel: 'chrome'`).

```bash
# Terminal A — Nordhavn Bank (shell :4200 + MFEs)
cd ~/Workspace/angular/mock-bank-mfe
npm run dev

# Terminal B — Vista Canvas
cd ~/Workspace/typescript/vista-canvas
cp .env.example .env   # optional; set DESIGN_CANVAS_* as needed
export DESIGN_CANVAS_TARGET=~/Workspace/angular/mock-bank-mfe
# optional: export DESIGN_CANVAS_APP_ORIGIN=http://localhost:4200
npm install
npm run typecheck
npm run build
npm run dev
```

Then open **http://127.0.0.1:4173**.

- UI (Vite): `127.0.0.1:4173` — proxies `/api` → API
- Agent API: `127.0.0.1:4174` — JSON + SSE + snapshot capture + runtime map
- Bank shell: `localhost:4200` — crawl + capture target; live iframe for focused workspace

### Layout & dragging

- Drag screens/modules by the card **or** the header title pill.
- **Auto layout** (dock button, `POST /api/layout`, or `auto_layout`) places the module hub on the left, **entry/nav screens stacked in one column**, and **flow children in columns to the right** (aligned to their parent). Fits the camera to the graph. **Map** also applies this layout.

### Map the running app

Press **Map** in the overview dock, or:

```bash
curl -s -X POST http://127.0.0.1:4174/api/map \
  -H 'content-type: application/json' \
  -d '{"mode":"merge"}' | jq '{discovered, added, updated, screens: (.document.nodes|map(select(.kind=="screen"))|length)}'
```

- **`merge` (default — prefer this):** upsert screens + crawl edges; keep modules, fixtures, unmatched screens, and positions. Drops redundant sibling URLs (e.g. extra `/accounts/:id` instances).
- **`replace`:** rebuild screens from the crawl; keep modules; **remap** fixture `parentId`s onto surviving routes (drop only true orphans).

Mapping does **not** read MFE source. It crawls same-origin links from the host (skips `/__canvas/`, query strings, logout). Sibling paths that only differ by an entity id collapse into one parameterized screen (`/accounts/everyday` + `/accounts/savings` → route `/accounts/:accountId`, one `previewPath`).

Link classification after the crawl:

- **Chrome destinations** (same link on ≥2 pages and ≥50% of visited pages) become `kind: "nav"` edges from a **module hub** (existing nav/shell/menu module, or a created `nav-hub`).
- **Local / path-child** links (e.g. `/` → `/accounts/everyday`, `/transfer` → `/transfer/confirm`) become `kind: "flow"` between screens.
- Screen↔screen menu edges (`Accounts → Transfer`) are dropped — those hang off the hub instead.

### Overview levels

| Level | Behavior |
| :--- | :--- |
| **Node view** (`macro`) | Topology cards (title, route, MFE). No mounts. |
| **Live preview** (`meso`) | Larger nodes with **cached WebP stills**. Skeleton first, then image. |

### Node kinds

| Kind | Visible in overview | Focus | Notes |
| :--- | :--- | :--- | :--- |
| **`screen`** | Yes | Full-page workspace (default 1280×800) | Destinations (`/`, `/transfer`, …) |
| **`module`** | Yes | Workspace uses that node’s `frame` | Chrome/slots (nav rail). Curated, not crawled |
| **`fixture`** | Hidden | Satellite variants of the parent screen | `parentId` + `?fixture=` — curated |

Edges are `kind: "flow"` (in-product screen steps) or `kind: "nav"` (module hub → chrome destination).

### Screen focus

Double-click a screen or module to **lift** it onto a focused canvas with a live iframe of the host route. **Back to overview** / Escape exits. There is no inline edit composer — iterate in the IDE / Copilot chat while watching the focused iframe.

### Copilot bring-up (work / mock env)

Prerequisites: **Node ≥22**, system **Google Chrome** (Playwright `channel: 'chrome'`), and a built `dist/` (`dist/` is gitignored).

1. Clone this repo + the target host (mock-bank or work host).
2. Start the host so the shell is reachable (`DESIGN_CANVAS_APP_ORIGIN`).
3. In this repo: `npm install && npm run build` (required — the extension only spawns `dist/web/main.js`).
4. Set env (shell or `.env` from `.env.example`):

   ```bash
   export DESIGN_CANVAS_TARGET=/absolute/path/to/host-repo
   export DESIGN_CANVAS_APP_ORIGIN=http://localhost:4200
   # Auth’d staging (optional):
   # export DESIGN_CANVAS_STORAGE_STATE=/absolute/path/to/.design-canvas-auth.json
   ```

5. Prefer opening **this** repo in the GitHub Copilot app. Open canvas **Vista Canvas**.
6. If nothing is listening on `:4173`, the extension spawns `dist/web/main.js` with `DESIGN_CANVAS_SERVE_UI=1` (one process serves UI + API). It only kills processes it spawned.
7. First open may be an **empty graph** until you Map (or until the target already has `.design-canvas.json`). Ask Copilot to `map_application` (**merge**), or press **Map**. Then attach states with `add_fixture_node` as needed.

If Copilot’s workspace is a different repo, copy `.github/extensions/vista-canvas/` into that workspace or into `~/.copilot/extensions/`, and set **`DESIGN_CANVAS_HOME`** to this package clone (so spawn can find `dist/`).

Authenticated hosts: capture a Playwright storage file once, then point `DESIGN_CANVAS_STORAGE_STATE` at it (used by Map + meso stills):

```bash
npx playwright codegen --save-storage=./.design-canvas-auth.json "$DESIGN_CANVAS_APP_ORIGIN"
export DESIGN_CANVAS_STORAGE_STATE=/absolute/path/to/.design-canvas-auth.json
```

Single-process mode without Copilot:

```bash
npm run build
DESIGN_CANVAS_TARGET=… DESIGN_CANVAS_APP_ORIGIN=… npm run start:web
# → http://127.0.0.1:4173
```

### MCP App (inline Cursor adapter)

```bash
DESIGN_CANVAS_TARGET=~/Workspace/angular/mock-bank-mfe npm run start:mcp
```

Register in **`~/.cursor/mcp.json`**:

```json
{
  "mcpServers": {
    "vista-canvas": {
      "command": "node",
      "args": [
        "/Users/patrickjessen/Workspace/typescript/vista-canvas/dist/mcp/main.js"
      ],
      "env": {
        "DESIGN_CANVAS_TARGET": "/Users/patrickjessen/Workspace/angular/mock-bank-mfe",
        "DESIGN_CANVAS_APP_ORIGIN": "http://localhost:4200"
      }
    }
  }
}
```

## Module Layout

- `PLAN.md` — Living plan (current scope, decision log)
- `.github/extensions/vista-canvas/` — Copilot Canvas Extension
- `src/types/` — Core canvas domain types + Zod schemas
- `src/store/` — `.design-canvas.json` read/write + runtime-map apply
- `src/actions/` — Shared `CanvasActions` + in-process event bus
- `src/mcp/` — Cursor MCP App adapter (`ui://design-canvas`)
- `src/web/` — HTTP agent API + SSE + snapshots + static UI serve
- `src/canvas/` — Host-agnostic renderer + MCP / web host clients
- `src/adapters/` — `ViewportNode`, `SnapshotAdapter`, `WebIframeAdapter`
- `src/preview/` — preview URL helpers, Playwright snapshots, **runtime mapper**

## Agent API

| Surface | Operation |
| :--- | :--- |
| `GET /api/canvas` / `list_canvas` | Read document |
| `GET /api/config` | `{ appOrigin, sprint, serveUi }` |
| `GET /api/snapshots` | Capture or return cached WebP |
| `POST /api/snapshots/invalidate` | Drop the in-memory snapshot cache |
| `POST /api/map` / `map_application` | Crawl host → upsert screens |
| `POST /api/layout` / `auto_layout` | Column layout by route depth |
| `POST /api/nodes` / `add_screen_node` | Add screen node |
| `POST /api/fixtures` / `add_fixture_node` | Add fixture child of a screen (HTTP, MCP, Copilot) |
| `POST /api/modules` / `add_module_node` | Add module/chrome node (HTTP, MCP, Copilot) |
| `POST /api/select` / `select_node` | Select / clear node |
| `POST /api/focus` / `focus_node` | Enter / exit focused workspace |
| `POST /api/nodes/move` / `move_node` | Move a node |
| `PATCH /api/view` / `update_view` | Persist pan/zoom / focus / semantic zoom |
| `GET /api/events` | SSE `document` stream |
| `open_design_canvas` | MCP-only — open inline UI |

State lives in the target repo at `.design-canvas.json`. Nodes may set `previewPath` when `route` is parameterized.
