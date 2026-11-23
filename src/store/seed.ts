import type { DesignCanvasDocument } from '../types/domain.js';

/** Empty graph for a new target. Runtime mapping fills topology. */
export function createSeedDocument(target = 'app'): DesignCanvasDocument {
  return {
    version: 1,
    target,
    nodes: [],
    edges: [],
    view: {
      pan: { x: 24, y: 48 },
      zoom: 0.72,
      selectedNodeId: null,
      focusedNodeId: null,
      semanticZoomLevel: 'macro',
    },
  };
}
