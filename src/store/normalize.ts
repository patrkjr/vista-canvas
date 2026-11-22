import type {
  CanvasEdge,
  CanvasNode,
  CanvasViewState,
  DesignCanvasDocument,
} from '../types/domain.js';
import type { DesignCanvasDocumentParsed } from '../types/schema.js';

export function normalizeDocument(parsed: DesignCanvasDocumentParsed): DesignCanvasDocument {
  const rawNodes = parsed.nodes.map(normalizeNode);
  const screenIds = new Set(
    rawNodes.filter((node) => node.kind === 'screen').map((node) => node.id)
  );
  // Drop fixtures whose parent screen is missing.
  const nodes = rawNodes.filter(
    (node) => node.kind !== 'fixture' || (node.parentId !== undefined && screenIds.has(node.parentId))
  );

  return {
    version: parsed.version,
    target: parsed.target,
    nodes,
    edges: parsed.edges.map(normalizeEdge),
    view: normalizeView(parsed.view, nodes),
  };
}

function normalizeNode(node: DesignCanvasDocumentParsed['nodes'][number]): CanvasNode {
  return {
    id: node.id,
    kind: node.kind,
    title: node.title,
    route: node.route,
    mfe: node.mfe,
    position: { x: node.position.x, y: node.position.y },
    ...(node.dataScreen !== undefined ? { dataScreen: node.dataScreen } : {}),
    ...(node.previewPath !== undefined ? { previewPath: node.previewPath } : {}),
    ...(node.parentId !== undefined ? { parentId: node.parentId } : {}),
    ...(node.fixture !== undefined ? { fixture: node.fixture } : {}),
    ...(node.frame !== undefined
      ? { frame: { width: node.frame.width, height: node.frame.height } }
      : {}),
  };
}

function normalizeEdge(edge: DesignCanvasDocumentParsed['edges'][number]): CanvasEdge {
  return {
    id: edge.id,
    from: edge.from,
    to: edge.to,
    kind: edge.kind ?? 'flow',
    ...(edge.label !== undefined ? { label: edge.label } : {}),
  };
}

function normalizeView(
  view: DesignCanvasDocumentParsed['view'],
  nodes: readonly CanvasNode[]
): CanvasViewState {
  // Legacy Sprint 3 "micro" was a global interactive mount; coerce to meso overview.
  const semanticZoomLevel = view.semanticZoomLevel === 'micro' ? 'meso' : view.semanticZoomLevel;
  const rawFocused = view.focusedNodeId ?? null;
  const focusedNodeId =
    rawFocused !== null && nodes.some((node) => node.id === rawFocused) ? rawFocused : null;
  return {
    pan: { x: view.pan.x, y: view.pan.y },
    zoom: view.zoom,
    selectedNodeId: view.selectedNodeId,
    focusedNodeId,
    semanticZoomLevel,
  };
}
