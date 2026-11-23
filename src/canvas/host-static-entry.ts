import './styles.css';
import seed from '../../demo/seed/design-canvas.json';
import { createStaticHost, resolveStaticAppOrigin } from './host-static';
import { mountCanvasRenderer } from './render';
import { isDesignCanvasDocument, type DesignCanvasDocument } from './types';

const viewportEl = document.getElementById('viewport')!;
const worldEl = document.getElementById('world')!;
const edgesEl = document.getElementById('edges') as unknown as SVGSVGElement;
const zoomControlsEl = document.getElementById('zoom-controls');

if (!isDesignCanvasDocument(seed)) {
  throw new Error('demo/seed/design-canvas.json is not a valid canvas document');
}

const host = createStaticHost({
  seed: seed as DesignCanvasDocument,
  appOrigin: resolveStaticAppOrigin(),
});

const renderer = mountCanvasRenderer({
  host,
  viewportEl,
  worldEl,
  edgesEl,
  zoomControlsEl,
});

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    renderer.destroy();
  });
}

void bootstrap();

async function bootstrap(): Promise<void> {
  try {
    const doc = await host.loadDocument();
    renderer.applyDocument(doc, 'Static demo');
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Failed to load canvas');
  }
}
