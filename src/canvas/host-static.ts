import type {
  CanvasHost,
  CanvasPoint,
  DesignCanvasDocument,
  SemanticZoomLevel,
} from './types';
import { isDesignCanvasDocument } from './types';

export interface StaticHostOptions {
  seed: DesignCanvasDocument;
  /** Absolute origin for the packaged bank shell, e.g. https://demo.vercel.app/mock-bank */
  appOrigin: string;
}

/**
 * In-browser canvas host for a static export — no Node API, SSE, snapshots, or mapping.
 * Document mutations stay in memory for the session.
 */
export function createStaticHost(options: StaticHostOptions): CanvasHost {
  if (!isDesignCanvasDocument(options.seed)) {
    throw new Error('Static host seed is not a design canvas document');
  }

  let document = normalizeSeed(options.seed);
  const listeners = new Set<(next: DesignCanvasDocument) => void>();
  const appOrigin = options.appOrigin.replace(/\/$/, '');

  function snapshot(): DesignCanvasDocument {
    return structuredClone(document);
  }

  function commit(next: DesignCanvasDocument): DesignCanvasDocument {
    document = next;
    const published = snapshot();
    for (const listener of listeners) {
      try {
        listener(published);
      } catch (error) {
        console.error('[static-host] listener failed:', error);
      }
    }
    return published;
  }

  return {
    loadDocument: async () => snapshot(),

    getConfig: async () => ({ appOrigin }),

    selectNode: async (nodeId) => {
      if (nodeId !== null && !document.nodes.some((node) => node.id === nodeId)) {
        throw new Error(`Unknown node: ${nodeId}`);
      }
      return commit({
        ...document,
        view: { ...document.view, selectedNodeId: nodeId },
      });
    },

    focusNode: async (nodeId) => {
      const focusedNodeId =
        nodeId !== null && document.nodes.some((node) => node.id === nodeId)
          ? nodeId
          : null;
      return commit({
        ...document,
        view: {
          ...document.view,
          focusedNodeId,
          ...(focusedNodeId !== null ? { selectedNodeId: focusedNodeId } : {}),
        },
      });
    },

    moveNode: async (nodeId, position: CanvasPoint) => {
      const index = document.nodes.findIndex((node) => node.id === nodeId);
      if (index < 0) throw new Error(`Unknown node: ${nodeId}`);
      const nodes = document.nodes.slice();
      nodes[index] = { ...nodes[index]!, position: { x: position.x, y: position.y } };
      return commit({ ...document, nodes });
    },

    updateView: async (patch: {
      pan?: CanvasPoint;
      zoom?: number;
      selectedNodeId?: string | null;
      focusedNodeId?: string | null;
      semanticZoomLevel?: SemanticZoomLevel;
    }) => {
      const nextFocused =
        patch.focusedNodeId !== undefined
          ? patch.focusedNodeId
          : document.view.focusedNodeId;
      const focusedNodeId =
        nextFocused !== null && document.nodes.some((node) => node.id === nextFocused)
          ? nextFocused
          : null;
      const selectedNodeId =
        patch.selectedNodeId !== undefined
          ? patch.selectedNodeId
          : patch.focusedNodeId !== undefined && focusedNodeId !== null
            ? focusedNodeId
            : document.view.selectedNodeId;

      return commit({
        ...document,
        view: {
          ...document.view,
          ...patch,
          focusedNodeId,
          selectedNodeId,
        },
      });
    },

    onDocument(handler) {
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    },
  };
}

function normalizeSeed(seed: DesignCanvasDocument): DesignCanvasDocument {
  const doc = structuredClone(seed);
  // Start the public demo on the overview — not a leftover focused workspace.
  doc.view = {
    ...doc.view,
    focusedNodeId: null,
    semanticZoomLevel:
      doc.view.semanticZoomLevel === 'micro' ? 'meso' : doc.view.semanticZoomLevel,
  };
  return doc;
}

/** Resolve packaged bank origin relative to the current page. */
export function resolveStaticAppOrigin(): string {
  return new URL('mock-bank/', window.location.href).href.replace(/\/$/, '');
}
