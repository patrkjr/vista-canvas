/**
 * GitHub Copilot Canvas Extension for Vista Canvas.
 * Runtime resolves @github/copilot-sdk — do not npm-install it here.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CanvasError, createCanvas, joinSession } from '@github/copilot-sdk/extension';
import declaration from './extension.json' with { type: 'json' };

const CANVAS_ID = 'vista-canvas';
const DEFAULT_URL = 'http://127.0.0.1:4173';
const HEALTH_PATH = '/api/health';
const PACKAGE_NAME = 'vista-canvas';

/**
 * Package root for spawning dist/web/main.js.
 * Prefer DESIGN_CANVAS_HOME when the extension is copied outside the repo
 * (e.g. ~/.copilot/extensions/); else walk up for package.json; else
 * assume .github/extensions/vista-canvas → repo root.
 */
function resolvePackageRoot() {
  const fromEnv = process.env.DESIGN_CANVAS_HOME?.trim();
  if (fromEnv) {
    const resolved = path.resolve(fromEnv);
    if (existsSync(path.join(resolved, 'dist/web/main.js'))) return resolved;
    if (existsSync(path.join(resolved, 'package.json'))) return resolved;
  }

  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    const pkgPath = path.join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
        if (pkg?.name === PACKAGE_NAME) return dir;
      } catch {
        // keep walking
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
}

const PACKAGE_ROOT = resolvePackageRoot();

/** @type {Map<string, { url: string, child: import('node:child_process').ChildProcess | null, spawned: boolean }>} */
const instances = new Map();

async function api(pathname, init = {}) {
  const base = instances.values().next().value?.url ?? DEFAULT_URL;
  const response = await fetch(`${base}${pathname}`, {
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    ...init,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      typeof payload?.error === 'string' ? payload.error : `HTTP ${response.status}`;
    throw new CanvasError('api_error', message);
  }
  return payload;
}

async function isHealthy(url) {
  try {
    const response = await fetch(`${url}${HEALTH_PATH}`, {
      signal: AbortSignal.timeout(1500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForHealthy(url, attempts = 40) {
  for (let i = 0; i < attempts; i += 1) {
    if (await isHealthy(url)) return true;
    await delay(250);
  }
  return false;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Start the built web stack if nothing is listening on 4173.
 * Only processes we spawn are stopped on close.
 */
async function ensureServer(input = {}) {
  const url = DEFAULT_URL;
  if (await isHealthy(url)) {
    return { url, child: null, spawned: false };
  }

  const env = {
    ...process.env,
    DESIGN_CANVAS_SERVE_UI: '1',
    DESIGN_CANVAS_API_PORT: '4173',
  };
  if (typeof input.target === 'string' && input.target.trim()) {
    env.DESIGN_CANVAS_TARGET = input.target.trim();
  }
  if (typeof input.appOrigin === 'string' && input.appOrigin.trim()) {
    env.DESIGN_CANVAS_APP_ORIGIN = input.appOrigin.trim();
  }

  const child = spawn(process.execPath, [path.join(PACKAGE_ROOT, 'dist/web/main.js')], {
    cwd: PACKAGE_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout?.on('data', (chunk) => {
    process.stderr.write(`[vista-canvas] ${chunk}`);
  });
  child.stderr?.on('data', (chunk) => {
    process.stderr.write(`[vista-canvas] ${chunk}`);
  });

  const ready = await waitForHealthy(url);
  if (!ready) {
    child.kill('SIGTERM');
    throw new CanvasError(
      'server_start_failed',
      `Canvas server did not become healthy on http://127.0.0.1:4173. Run npm run build, set DESIGN_CANVAS_TARGET (and DESIGN_CANVAS_HOME=${PACKAGE_ROOT} if the extension is copied outside the repo), and ensure Chrome is installed.`
    );
  }

  return { url, child, spawned: true };
}

const actionHandlers = {
  list_canvas: async () => api('/api/canvas'),

  map_application: async ({ input }) =>
    api('/api/map', {
      method: 'POST',
      body: JSON.stringify({
        ...(input?.mode ? { mode: input.mode } : {}),
      }),
    }),

  auto_layout: async () =>
    api('/api/layout', {
      method: 'POST',
      body: '{}',
    }),

  add_screen_node: async ({ input }) =>
    api('/api/nodes', {
      method: 'POST',
      body: JSON.stringify(input ?? {}),
    }),

  add_fixture_node: async ({ input }) =>
    api('/api/fixtures', {
      method: 'POST',
      body: JSON.stringify(input ?? {}),
    }),

  add_module_node: async ({ input }) =>
    api('/api/modules', {
      method: 'POST',
      body: JSON.stringify(input ?? {}),
    }),

  select_node: async ({ input }) =>
    api('/api/select', {
      method: 'POST',
      body: JSON.stringify({ nodeId: input?.nodeId ?? null }),
    }),

  focus_node: async ({ input }) =>
    api('/api/focus', {
      method: 'POST',
      body: JSON.stringify({ nodeId: input?.nodeId ?? null }),
    }),

  move_node: async ({ input }) =>
    api('/api/nodes/move', {
      method: 'POST',
      body: JSON.stringify({
        nodeId: input?.nodeId,
        x: input?.x,
        y: input?.y,
      }),
    }),

  update_view: async ({ input }) =>
    api('/api/view', {
      method: 'PATCH',
      body: JSON.stringify(input ?? {}),
    }),
};

const canvasDecl = declaration.canvases.find((c) => c.id === CANVAS_ID);
if (!canvasDecl) {
  throw new Error(`Missing canvas declaration for ${CANVAS_ID}`);
}

const canvas = createCanvas({
  ...canvasDecl,
  actions: (canvasDecl.actions ?? []).map((action) => ({
    ...action,
    handler: async (ctx) => {
      const handler = actionHandlers[action.name];
      if (!handler) {
        throw CanvasError.noHandler();
      }
      return handler(ctx);
    },
  })),
  open: async ({ instanceId, input }) => {
    const existing = instances.get(instanceId);
    if (existing) {
      return { url: existing.url, title: 'Vista Canvas' };
    }
    const started = await ensureServer(input ?? {});
    instances.set(instanceId, started);
    return { url: started.url, title: 'Vista Canvas' };
  },
  onClose: async ({ instanceId }) => {
    const entry = instances.get(instanceId);
    instances.delete(instanceId);
    if (entry?.spawned && entry.child && !entry.child.killed) {
      entry.child.kill('SIGTERM');
    }
  },
});

await joinSession({
  canvases: [canvas],
});
