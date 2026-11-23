import './styles.css';
import { createWebHost } from './host-web';
import { mountCanvasRenderer } from './render';

const viewportEl = document.getElementById('viewport')!;
const worldEl = document.getElementById('world')!;
const edgesEl = document.getElementById('edges') as unknown as SVGSVGElement;
const zoomControlsEl = document.getElementById('zoom-controls');

const host = createWebHost('');
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
    renderer.applyDocument(doc, 'Ready');
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Failed to load canvas');
  }
}
