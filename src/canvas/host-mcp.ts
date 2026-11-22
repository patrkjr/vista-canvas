import { App } from '@modelcontextprotocol/ext-apps';

import {
  isDesignCanvasDocument,
  type CanvasHost,
  type CanvasHostConfig,
  type CanvasPoint,
  type DesignCanvasDocument,
  type SemanticZoomLevel,
} from './types';

const DEFAULT_APP_ORIGIN = 'http://localhost:4200';

export function createMcpHost(app: App): CanvasHost {
  const documentHandlers = new Set<(document: DesignCanvasDocument) => void>();

  app.ontoolresult = (result) => {
    const doc = extractDocument(result);
    if (!doc) return;
    for (const handler of documentHandlers) handler(doc);
  };

  return {
    async loadDocument() {
      const result = await app.callServerTool({ name: 'list_canvas', arguments: {} });
      const doc = extractDocument(result);
      if (!doc) throw new Error('list_canvas did not return a design canvas document');
      return doc;
    },

    async getConfig(): Promise<CanvasHostConfig> {
      // MCP App has no HTTP /api/config; use the same default as the web server.
      return { appOrigin: DEFAULT_APP_ORIGIN };
    },

    async selectNode(nodeId) {
      const result = await app.callServerTool({
        name: 'select_node',
        arguments: { nodeId },
      });
      const doc = extractDocument(result);
      if (!doc) throw new Error('select_node did not return a design canvas document');
      return doc;
    },

    async focusNode(nodeId) {
      const result = await app.callServerTool({
        name: 'focus_node',
        arguments: { nodeId },
      });
      const doc = extractDocument(result);
      if (!doc) throw new Error('focus_node did not return a design canvas document');
      return doc;
    },

    async moveNode(nodeId, position) {
      const result = await app.callServerTool({
        name: 'move_node',
        arguments: { nodeId, x: position.x, y: position.y },
      });
      const doc = extractDocument(result);
      if (!doc) throw new Error('move_node did not return a design canvas document');
      return doc;
    },

    async updateView(patch: {
      pan?: CanvasPoint;
      zoom?: number;
      selectedNodeId?: string | null;
      focusedNodeId?: string | null;
      semanticZoomLevel?: SemanticZoomLevel;
    }) {
      const result = await app.callServerTool({
        name: 'update_view',
        arguments: {
          ...(patch.pan !== undefined ? { pan: patch.pan } : {}),
          ...(patch.zoom !== undefined ? { zoom: patch.zoom } : {}),
          ...(patch.selectedNodeId !== undefined
            ? { selectedNodeId: patch.selectedNodeId }
            : {}),
          ...(patch.focusedNodeId !== undefined
            ? { focusedNodeId: patch.focusedNodeId }
            : {}),
          ...(patch.semanticZoomLevel !== undefined
            ? { semanticZoomLevel: patch.semanticZoomLevel }
            : {}),
        },
      });
      const doc = extractDocument(result);
      if (!doc) throw new Error('update_view did not return a design canvas document');
      return doc;
    },

    onDocument(handler) {
      documentHandlers.add(handler);
      return () => {
        documentHandlers.delete(handler);
      };
    },
  };
}

export function extractDocument(result: unknown): DesignCanvasDocument | null {
  if (typeof result !== 'object' || result === null) return null;
  const candidate = result as {
    structuredContent?: unknown;
    content?: Array<{ type?: string; text?: string }>;
  };

  if (isDesignCanvasDocument(candidate.structuredContent)) {
    return candidate.structuredContent;
  }

  const text = candidate.content?.find((block) => block.type === 'text')?.text;
  if (!text) return null;

  const jsonStart = text.indexOf('{');
  if (jsonStart < 0) return null;

  try {
    const parsed: unknown = JSON.parse(text.slice(jsonStart));
    return isDesignCanvasDocument(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
