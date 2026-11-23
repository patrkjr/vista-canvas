import { watch, type FSWatcher } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { CanvasActions } from '../actions/canvas-actions.js';
import { buildPreviewUrl, resolveAppOrigin } from '../preview/preview-url.js';
import {
  parseColorScheme,
  SnapshotService,
} from '../preview/snapshot-service.js';
import type { DesignCanvasDocument } from '../types/domain.js';
import { SemanticZoomLevelSchema } from '../types/schema.js';

const AddNodeBodySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  route: z.string().min(1),
  mfe: z.string().min(1),
  x: z.number(),
  y: z.number(),
  dataScreen: z.string().min(1).optional(),
});

const AddFixtureBodySchema = z.object({
  id: z.string().min(1),
  parentId: z.string().min(1),
  title: z.string().min(1),
  fixture: z.string().min(1),
  previewPath: z.string().min(1),
  mfe: z.string().min(1).optional(),
  x: z.number().optional(),
  y: z.number().optional(),
});

const AddModuleBodySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  route: z.string().min(1),
  mfe: z.string().min(1),
  x: z.number(),
  y: z.number(),
  previewPath: z.string().min(1).optional(),
  dataScreen: z.string().min(1).optional(),
  frame: z
    .object({
      width: z.number().positive(),
      height: z.number().positive(),
    })
    .optional(),
  parentId: z.string().min(1).optional(),
});

const SelectBodySchema = z.object({
  nodeId: z.string().nullable(),
});

const FocusBodySchema = z.object({
  nodeId: z.string().nullable(),
});

const MoveNodeBodySchema = z.object({
  nodeId: z.string().min(1),
  x: z.number(),
  y: z.number(),
});

const ViewBodySchema = z.object({
  pan: z.object({ x: z.number(), y: z.number() }).optional(),
  zoom: z.number().positive().optional(),
  selectedNodeId: z.string().nullable().optional(),
  focusedNodeId: z.string().nullable().optional(),
  semanticZoomLevel: SemanticZoomLevelSchema.optional(),
});

const MapBodySchema = z.object({
  mode: z.enum(['merge', 'replace']).optional(),
});

const SCOPE_VERSION = 9;

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

export interface WebServerOptions {
  host?: string;
  port?: number;
  actions?: CanvasActions;
  corsOrigin?: string;
  /** Origin of the target app shell (iframe mounts). Defaults to DESIGN_CANVAS_APP_ORIGIN or :4200. */
  appOrigin?: string;
  /** Serve Vite `dist/` UI alongside `/api` (Copilot / start:web). */
  serveUi?: boolean;
  /** Directory containing built index.html (default: package dist/). */
  uiRoot?: string;
}

export interface RunningWebServer {
  server: Server;
  port: number;
  host: string;
  close: () => Promise<void>;
}

/**
 * Agent HTTP API + SSE. Vite UI proxies `/api` here in dev.
 * With DESIGN_CANVAS_SERVE_UI=1, also serves the built web UI (default port 4173).
 */
export function createWebServer(options: WebServerOptions = {}): RunningWebServer {
  const serveUi =
    options.serveUi ??
    (process.env.DESIGN_CANVAS_SERVE_UI === '1' ||
      process.env.DESIGN_CANVAS_SERVE_UI === 'true');
  const host = options.host ?? '127.0.0.1';
  const port =
    options.port ??
    Number(process.env.DESIGN_CANVAS_API_PORT ?? (serveUi ? 4173 : 4174));
  const corsOrigin = options.corsOrigin ?? process.env.DESIGN_CANVAS_CORS_ORIGIN ?? '*';
  const appOrigin = resolveAppOrigin(options.appOrigin);
  const actions = options.actions ?? new CanvasActions();
  const snapshots = new SnapshotService();
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const uiRoot = options.uiRoot ?? path.join(packageRoot, 'dist');

  const sseClients = new Set<ServerResponse>();
  let lastPayload = '';
  let fileWatcher: FSWatcher | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const broadcast = (document: DesignCanvasDocument): void => {
    const payload = JSON.stringify(document);
    if (payload === lastPayload) return;
    lastPayload = payload;
    const chunk = `event: document\ndata: ${payload}\n\n`;
    for (const client of sseClients) {
      client.write(chunk);
    }
  };

  const unsubscribeActions = actions.subscribe(broadcast);

  const scheduleFileReload = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      void actions
        .read()
        .then(broadcast)
        .catch((error) => {
          console.error('[web] failed to reload after file change:', error);
        });
    }, 50);
  };

  try {
    fileWatcher = watch(actions.store.documentPath, { persistent: true }, scheduleFileReload);
  } catch {
    // File may not exist yet; CanvasStore seeds on first read.
    void actions.read().then(() => {
      fileWatcher = watch(actions.store.documentPath, { persistent: true }, scheduleFileReload);
    });
  }

  const server = createServer((req, res) => {
    void handleRequest(req, res);
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    applyCors(res, corsOrigin);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://${host}:${port}`);
    const { pathname } = url;

    try {
      if (req.method === 'GET' && pathname === '/api/canvas') {
        const document = await actions.list();
        return sendJson(res, 200, document);
      }

      if (req.method === 'POST' && pathname === '/api/nodes') {
        const body = AddNodeBodySchema.parse(await readJson(req));
        const document = await actions.addScreenNode({
          id: body.id,
          title: body.title,
          route: body.route,
          mfe: body.mfe,
          x: body.x,
          y: body.y,
          ...(body.dataScreen !== undefined ? { dataScreen: body.dataScreen } : {}),
        });
        return sendJson(res, 201, document);
      }

      if (req.method === 'POST' && pathname === '/api/fixtures') {
        const body = AddFixtureBodySchema.parse(await readJson(req));
        const document = await actions.addFixtureNode({
          id: body.id,
          parentId: body.parentId,
          title: body.title,
          fixture: body.fixture,
          previewPath: body.previewPath,
          ...(body.mfe !== undefined ? { mfe: body.mfe } : {}),
          ...(body.x !== undefined ? { x: body.x } : {}),
          ...(body.y !== undefined ? { y: body.y } : {}),
        });
        return sendJson(res, 201, document);
      }

      if (req.method === 'POST' && pathname === '/api/modules') {
        const body = AddModuleBodySchema.parse(await readJson(req));
        const document = await actions.addModuleNode({
          id: body.id,
          title: body.title,
          route: body.route,
          mfe: body.mfe,
          x: body.x,
          y: body.y,
          ...(body.previewPath !== undefined ? { previewPath: body.previewPath } : {}),
          ...(body.dataScreen !== undefined ? { dataScreen: body.dataScreen } : {}),
          ...(body.frame !== undefined ? { frame: body.frame } : {}),
          ...(body.parentId !== undefined ? { parentId: body.parentId } : {}),
        });
        return sendJson(res, 201, document);
      }

      if (req.method === 'POST' && pathname === '/api/select') {
        const body = SelectBodySchema.parse(await readJson(req));
        const document = await actions.selectNode(body.nodeId);
        return sendJson(res, 200, document);
      }

      if (req.method === 'POST' && pathname === '/api/focus') {
        const body = FocusBodySchema.parse(await readJson(req));
        const document = await actions.focusNode(body.nodeId);
        return sendJson(res, 200, document);
      }

      if (req.method === 'POST' && pathname === '/api/nodes/move') {
        const body = MoveNodeBodySchema.parse(await readJson(req));
        const document = await actions.moveNode(body.nodeId, { x: body.x, y: body.y });
        return sendJson(res, 200, document);
      }

      if (req.method === 'PATCH' && pathname === '/api/view') {
        const body = ViewBodySchema.parse(await readJson(req));
        const document = await actions.updateView({
          ...(body.pan !== undefined ? { pan: body.pan } : {}),
          ...(body.zoom !== undefined ? { zoom: body.zoom } : {}),
          ...(body.selectedNodeId !== undefined
            ? { selectedNodeId: body.selectedNodeId }
            : {}),
          ...(body.focusedNodeId !== undefined
            ? { focusedNodeId: body.focusedNodeId }
            : {}),
          ...(body.semanticZoomLevel !== undefined
            ? { semanticZoomLevel: body.semanticZoomLevel }
            : {}),
        });
        return sendJson(res, 200, document);
      }

      if (req.method === 'POST' && pathname === '/api/map') {
        const body = MapBodySchema.parse(await readJson(req));
        const result = await actions.mapApplication({
          ...(body.mode !== undefined ? { mode: body.mode } : {}),
          appOrigin,
        });
        snapshots.invalidate();
        return sendJson(res, 200, {
          document: result.document,
          discovered: result.discovered,
          added: result.added,
          updated: result.updated,
        });
      }

      if (req.method === 'POST' && pathname === '/api/layout') {
        const document = await actions.autoLayout();
        snapshots.invalidate();
        return sendJson(res, 200, document);
      }

      if (req.method === 'GET' && pathname === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        sseClients.add(res);
        const document = await actions.list();
        const payload = JSON.stringify(document);
        lastPayload = payload;
        res.write(`event: document\ndata: ${payload}\n\n`);
        req.on('close', () => {
          sseClients.delete(res);
        });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/config') {
        return sendJson(res, 200, {
          appOrigin,
          sprint: SCOPE_VERSION,
          serveUi,
        });
      }

      if (req.method === 'GET' && pathname === '/api/health') {
        return sendJson(res, 200, {
          ok: true,
          sprint: SCOPE_VERSION,
          serveUi,
        });
      }

      if (req.method === 'GET' && pathname === '/api/snapshots') {
        const pathParam = url.searchParams.get('path');
        if (!pathParam || !pathParam.trim()) {
          return sendJson(res, 400, { error: 'path query is required' });
        }
        const width = Number(url.searchParams.get('w') ?? 1280);
        const height = Number(url.searchParams.get('h') ?? 800);
        if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
          return sendJson(res, 400, { error: 'w and h must be positive numbers' });
        }
        const colorScheme = parseColorScheme(url.searchParams.get('scheme'));
        const previewUrl = buildPreviewUrl(appOrigin, pathParam);
        const result = await snapshots.capture({
          previewUrl,
          width: Math.round(width),
          height: Math.round(height),
          colorScheme,
        });
        res.writeHead(200, {
          'Content-Type': result.contentType,
          'Content-Length': result.bytes.byteLength,
          'Cache-Control': 'no-store',
          'X-Snapshot-Cache': result.fromCache ? 'hit' : 'miss',
        });
        res.end(result.bytes);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/snapshots/invalidate') {
        const cleared = snapshots.invalidate();
        return sendJson(res, 200, { cleared });
      }

      if (serveUi && (req.method === 'GET' || req.method === 'HEAD')) {
        const served = await tryServeStatic(res, uiRoot, pathname, req.method === 'HEAD');
        if (served) return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
      const status = isZodError(error) ? 400 : 500;
      sendJson(res, status, { error: errorMessage(error) });
    }
  }

  server.listen(port, host);

  return {
    server,
    port,
    host,
    close: async () => {
      unsubscribeActions();
      if (debounceTimer) clearTimeout(debounceTimer);
      fileWatcher?.close();
      for (const client of sseClients) client.end();
      sseClients.clear();
      await snapshots.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function tryServeStatic(
  res: ServerResponse,
  uiRoot: string,
  pathname: string,
  headOnly: boolean
): Promise<boolean> {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  if (relative.includes('..')) return false;
  const filePath = path.resolve(uiRoot, relative);
  if (!filePath.startsWith(path.resolve(uiRoot))) return false;

  try {
    const bytes = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream',
      'Content-Length': bytes.byteLength,
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=60',
    });
    if (!headOnly) res.end(bytes);
    else res.end();
    return true;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  // SPA fallback for non-file routes.
  if (!path.extname(pathname)) {
    try {
      const indexBytes = await readFile(path.join(uiRoot, 'index.html'));
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': indexBytes.byteLength,
        'Cache-Control': 'no-store',
      });
      if (!headOnly) res.end(indexBytes);
      else res.end();
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function applyCors(res: ServerResponse, origin: string): void {
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  return JSON.parse(raw) as unknown;
}

function isZodError(error: unknown): boolean {
  return error instanceof z.ZodError;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
