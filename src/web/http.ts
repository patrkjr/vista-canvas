import { watch, type FSWatcher } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:http';

import { z } from 'zod';

import { CanvasActions } from '../actions/canvas-actions.js';
import { buildPreviewUrl, resolveAppOrigin } from '../preview/preview-url.js';
import {
  parseColorScheme,
  SnapshotService,
} from '../preview/snapshot-service.js';
import type { DesignCanvasDocument } from '../types/domain.js';
import { SemanticZoomLevelSchema } from '../types/schema.js';
import { EditAgent, EditAgentError } from './edit-agent.js';

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

const EditBodySchema = z.object({
  prompt: z.string().min(1),
  nodeId: z.string().min(1).optional(),
});

export interface WebServerOptions {
  host?: string;
  port?: number;
  actions?: CanvasActions;
  editAgent?: EditAgent;
  corsOrigin?: string;
  /** Origin of the target app shell (iframe mounts). Defaults to DESIGN_CANVAS_APP_ORIGIN or :4200. */
  appOrigin?: string;
}

export interface RunningWebServer {
  server: Server;
  port: number;
  host: string;
  close: () => Promise<void>;
}

/**
 * Agent HTTP API + SSE. Vite UI proxies `/api` here.
 * Default port 4174 so the browser surface stays on 4173.
 */
export function createWebServer(options: WebServerOptions = {}): RunningWebServer {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? Number(process.env.DESIGN_CANVAS_API_PORT ?? 4174);
  const corsOrigin = options.corsOrigin ?? process.env.DESIGN_CANVAS_CORS_ORIGIN ?? '*';
  const appOrigin = resolveAppOrigin(options.appOrigin);
  const actions = options.actions ?? new CanvasActions();
  const editAgent = options.editAgent ?? new EditAgent();
  const snapshots = new SnapshotService();

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

  const broadcastEdit = (payload: unknown): void => {
    const chunk = `event: edit\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of sseClients) {
      client.write(chunk);
    }
  };

  const unsubscribeActions = actions.subscribe(broadcast);
  const unsubscribeEdit = editAgent.subscribe((event) => {
    broadcastEdit(event);
    if (event.status === 'finished') {
      snapshots.invalidate();
    }
  });

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

      if (req.method === 'POST' && pathname === '/api/edit') {
        const body = EditBodySchema.parse(await readJson(req));
        const document = await actions.list();
        const nodeId = body.nodeId ?? document.view.focusedNodeId;
        if (!nodeId) {
          return sendJson(res, 400, {
            error: 'No focused node. Focus a screen first, or pass nodeId.',
          });
        }
        const node = document.nodes.find((candidate) => candidate.id === nodeId);
        if (!node) {
          return sendJson(res, 400, { error: `Unknown node: ${nodeId}` });
        }
        const result = await editAgent.send({
          prompt: body.prompt,
          node,
        });
        return sendJson(res, 202, result);
      }

      if (req.method === 'POST' && pathname === '/api/edit/cancel') {
        const result = await editAgent.cancel();
        return sendJson(res, 200, result);
      }

      if (req.method === 'POST' && pathname === '/api/edit/reset') {
        const result = await editAgent.reset();
        return sendJson(res, 200, result);
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
          sprint: 8,
          editConfigured: editAgent.configured,
        });
      }

      if (req.method === 'GET' && pathname === '/api/health') {
        return sendJson(res, 200, {
          ok: true,
          sprint: 8,
          editConfigured: editAgent.configured,
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

      sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
      if (error instanceof EditAgentError) {
        return sendJson(res, error.status, { error: error.message });
      }
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
      unsubscribeEdit();
      if (debounceTimer) clearTimeout(debounceTimer);
      fileWatcher?.close();
      for (const client of sseClients) client.end();
      sseClients.clear();
      await editAgent.close();
      await snapshots.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
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

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
