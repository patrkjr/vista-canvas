import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server';
import { McpServer } from '@modelcontextprotocol/server';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { CanvasActions } from '../actions/canvas-actions.js';
import { CanvasPointSchema, SemanticZoomLevelSchema } from '../types/schema.js';
import { documentToolResult, errorToolResult } from './document-result.js';

export const DESIGN_CANVAS_RESOURCE_URI = 'ui://design-canvas';

/** Compiled MCP lives in `dist/mcp/`; Vite emits `dist/design-canvas.html`. */
const DIST_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function createDesignCanvasServer(actions = new CanvasActions()): McpServer {
  const server = new McpServer({
    name: 'vista-canvas',
    version: '0.1.0',
  });

  registerAppTool(
    server,
    'open_design_canvas',
    {
      title: 'Open Design Canvas',
      description:
        'Open the Vista Canvas UI and return the current .design-canvas.json document.',
      inputSchema: z.object({}),
      _meta: {
        ui: { resourceUri: DESIGN_CANVAS_RESOURCE_URI },
      },
    },
    async () => {
      try {
        const document = await actions.list();
        return documentToolResult('Design canvas opened.', document);
      } catch (error) {
        return errorToolResult(errorMessage(error));
      }
    }
  );

  registerAppTool(
    server,
    'add_screen_node',
    {
      title: 'Add Screen Node',
      description: 'Add a screen node to the design canvas graph.',
      inputSchema: z.object({
        id: z.string().min(1),
        title: z.string().min(1),
        route: z.string().min(1),
        mfe: z.string().min(1),
        x: z.number(),
        y: z.number(),
        dataScreen: z.string().min(1).optional(),
      }),
      _meta: {
        ui: { resourceUri: DESIGN_CANVAS_RESOURCE_URI },
      },
    },
    async (args) => {
      try {
        const document = await actions.addScreenNode({
          id: args.id,
          title: args.title,
          route: args.route,
          mfe: args.mfe,
          x: args.x,
          y: args.y,
          ...(args.dataScreen !== undefined ? { dataScreen: args.dataScreen } : {}),
        });
        return documentToolResult(`Added screen node "${args.id}".`, document);
      } catch (error) {
        return errorToolResult(errorMessage(error));
      }
    }
  );

  registerAppTool(
    server,
    'add_fixture_node',
    {
      title: 'Add Fixture Node',
      description:
        'Add an edge-case fixture child of a screen. previewPath should include ?fixture=<key> for the target app.',
      inputSchema: z.object({
        id: z.string().min(1),
        parentId: z.string().min(1),
        title: z.string().min(1),
        fixture: z.string().min(1),
        previewPath: z.string().min(1),
        mfe: z.string().min(1).optional(),
        x: z.number().optional(),
        y: z.number().optional(),
      }),
      _meta: {
        ui: { resourceUri: DESIGN_CANVAS_RESOURCE_URI },
      },
    },
    async (args) => {
      try {
        const document = await actions.addFixtureNode({
          id: args.id,
          parentId: args.parentId,
          title: args.title,
          fixture: args.fixture,
          previewPath: args.previewPath,
          ...(args.mfe !== undefined ? { mfe: args.mfe } : {}),
          ...(args.x !== undefined ? { x: args.x } : {}),
          ...(args.y !== undefined ? { y: args.y } : {}),
        });
        return documentToolResult(`Added fixture node "${args.id}".`, document);
      } catch (error) {
        return errorToolResult(errorMessage(error));
      }
    }
  );

  registerAppTool(
    server,
    'add_module_node',
    {
      title: 'Add Module Node',
      description:
        'Add a module (chrome/slot) node. Optional frame is the native iframe size (e.g. nav rail 280×800). previewPath is a canvas-only shell mount such as /__canvas/module/nav.',
      inputSchema: z.object({
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
      }),
      _meta: {
        ui: { resourceUri: DESIGN_CANVAS_RESOURCE_URI },
      },
    },
    async (args) => {
      try {
        const document = await actions.addModuleNode({
          id: args.id,
          title: args.title,
          route: args.route,
          mfe: args.mfe,
          x: args.x,
          y: args.y,
          ...(args.previewPath !== undefined ? { previewPath: args.previewPath } : {}),
          ...(args.dataScreen !== undefined ? { dataScreen: args.dataScreen } : {}),
          ...(args.frame !== undefined ? { frame: args.frame } : {}),
          ...(args.parentId !== undefined ? { parentId: args.parentId } : {}),
        });
        return documentToolResult(`Added module node "${args.id}".`, document);
      } catch (error) {
        return errorToolResult(errorMessage(error));
      }
    }
  );

  registerAppTool(
    server,
    'select_node',
    {
      title: 'Select Node',
      description: 'Select a canvas node (or clear selection with null).',
      inputSchema: z.object({
        nodeId: z.string().nullable(),
      }),
      _meta: {
        ui: { resourceUri: DESIGN_CANVAS_RESOURCE_URI },
      },
    },
    async (args) => {
      try {
        const document = await actions.selectNode(args.nodeId);
        const label = args.nodeId ?? 'none';
        return documentToolResult(`Selected node: ${label}.`, document);
      } catch (error) {
        return errorToolResult(errorMessage(error));
      }
    }
  );

  registerAppTool(
    server,
    'focus_node',
    {
      title: 'Focus Node',
      description:
        'Enter the focused workspace for a screen, module, or fixture node, or pass null to return to the overview. Unknown ids exit focus.',
      inputSchema: z.object({
        nodeId: z.string().nullable(),
      }),
      _meta: {
        ui: { resourceUri: DESIGN_CANVAS_RESOURCE_URI },
      },
    },
    async (args) => {
      try {
        const document = await actions.focusNode(args.nodeId);
        const label = document.view.focusedNodeId ?? 'overview';
        return documentToolResult(`Focused: ${label}.`, document);
      } catch (error) {
        return errorToolResult(errorMessage(error));
      }
    }
  );

  registerAppTool(
    server,
    'move_node',
    {
      title: 'Move Node',
      description: 'Move a screen node to a new canvas position (edges stay attached).',
      inputSchema: z.object({
        nodeId: z.string().min(1),
        x: z.number(),
        y: z.number(),
      }),
      _meta: {
        ui: { resourceUri: DESIGN_CANVAS_RESOURCE_URI },
      },
    },
    async (args) => {
      try {
        const document = await actions.moveNode(args.nodeId, { x: args.x, y: args.y });
        return documentToolResult(`Moved node "${args.nodeId}".`, document);
      } catch (error) {
        return errorToolResult(errorMessage(error));
      }
    }
  );

  registerAppTool(
    server,
    'list_canvas',
    {
      title: 'List Canvas',
      description: 'Return the current design canvas document (nodes, edges, view).',
      inputSchema: z.object({}),
      _meta: {
        ui: { resourceUri: DESIGN_CANVAS_RESOURCE_URI },
      },
    },
    async () => {
      try {
        const document = await actions.list();
        return documentToolResult('Current design canvas document.', document);
      } catch (error) {
        return errorToolResult(errorMessage(error));
      }
    }
  );

  registerAppTool(
    server,
    'map_application',
    {
      title: 'Map Application',
      description:
        'Crawl the running host app (DESIGN_CANVAS_APP_ORIGIN) via Playwright and upsert screen nodes into .design-canvas.json. Remotes may load from CDN inside the host.',
      inputSchema: z.object({
        mode: z.enum(['merge', 'replace']).optional(),
      }),
      _meta: {
        ui: { resourceUri: DESIGN_CANVAS_RESOURCE_URI },
      },
    },
    async (args) => {
      try {
        const result = await actions.mapApplication({
          ...(args.mode !== undefined ? { mode: args.mode } : {}),
        });
        return documentToolResult(
          `Mapped ${result.discovered} screens (${result.added} added, ${result.updated} updated).`,
          result.document
        );
      } catch (error) {
        return errorToolResult(errorMessage(error));
      }
    }
  );

  registerAppTool(
    server,
    'auto_layout',
    {
      title: 'Auto Layout',
      description:
        'Reposition modules and screens into columns by route depth so nodes do not overlap.',
      inputSchema: z.object({}),
      _meta: {
        ui: { resourceUri: DESIGN_CANVAS_RESOURCE_URI },
      },
    },
    async () => {
      try {
        const document = await actions.autoLayout();
        return documentToolResult('Auto-laid out canvas nodes.', document);
      } catch (error) {
        return errorToolResult(errorMessage(error));
      }
    }
  );

  registerAppTool(
    server,
    'update_view',
    {
      title: 'Update View',
      description:
        'Persist pan/zoom (and optional selection / focus / semantic zoom) for the canvas.',
      inputSchema: z.object({
        pan: CanvasPointSchema.optional(),
        zoom: z.number().positive().optional(),
        selectedNodeId: z.string().nullable().optional(),
        focusedNodeId: z.string().nullable().optional(),
        semanticZoomLevel: SemanticZoomLevelSchema.optional(),
      }),
      _meta: {
        ui: {
          resourceUri: DESIGN_CANVAS_RESOURCE_URI,
          visibility: ['app'],
        },
      },
    },
    async (args) => {
      try {
        const document = await actions.updateView({
          ...(args.pan !== undefined ? { pan: args.pan } : {}),
          ...(args.zoom !== undefined ? { zoom: args.zoom } : {}),
          ...(args.selectedNodeId !== undefined
            ? { selectedNodeId: args.selectedNodeId }
            : {}),
          ...(args.focusedNodeId !== undefined
            ? { focusedNodeId: args.focusedNodeId }
            : {}),
          ...(args.semanticZoomLevel !== undefined
            ? { semanticZoomLevel: args.semanticZoomLevel }
            : {}),
        });
        return documentToolResult('Canvas view updated.', document);
      } catch (error) {
        return errorToolResult(errorMessage(error));
      }
    }
  );

  registerAppResource(
    server,
    'Design Canvas',
    DESIGN_CANVAS_RESOURCE_URI,
    {
      description: 'Spatial live-code design canvas (pan/zoom state graph).',
      mimeType: RESOURCE_MIME_TYPE,
    },
    async () => {
      const htmlPath = path.join(DIST_DIR, 'design-canvas.html');
      const html = await readFile(htmlPath, 'utf8');
      return {
        contents: [
          {
            uri: DESIGN_CANVAS_RESOURCE_URI,
            mimeType: RESOURCE_MIME_TYPE,
            text: html,
          },
        ],
      };
    }
  );

  return server;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
