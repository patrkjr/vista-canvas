import type { DesignCanvasMetadata } from './types/domain.js';

export * from './types/domain.js';
export * from './types/schema.js';
export { CanvasStore, documentPathFor, resolveTargetRoot } from './store/canvas-store.js';
export { createSeedDocument } from './store/seed.js';
export { CanvasActions } from './actions/canvas-actions.js';
export { createDesignCanvasServer, DESIGN_CANVAS_RESOURCE_URI } from './mcp/server.js';
export { createWebServer } from './web/http.js';
export { buildPreviewUrl, resolveAppOrigin, resolvePreviewPath } from './preview/preview-url.js';

export const CANVAS_METADATA: DesignCanvasMetadata = {
  name: 'spatial-design-canvas',
  version: '0.1.0',
  currentSprint: 7,
  supportedZoomLevels: ['macro', 'meso'],
  supportedRenderModes: ['structural', 'styled'],
  plannedAdapters: ['web-iframe', 'snapshot', 'native-stream'],
};

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(
    `[${CANVAS_METADATA.name} v${CANVAS_METADATA.version}] Sprint ${CANVAS_METADATA.currentSprint} — Meso bitmap snapshots.`
  );
}
