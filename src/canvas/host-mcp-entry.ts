import { App } from '@modelcontextprotocol/ext-apps';

import './styles.css';
import { createMcpHost } from './host-mcp';
import { mountCanvasRenderer } from './render';

const viewportEl = document.getElementById('viewport')!;
const worldEl = document.getElementById('world')!;
const edgesEl = document.getElementById('edges') as unknown as SVGSVGElement;
const zoomControlsEl = document.getElementById('zoom-controls');

const app = new App({ name: 'vista-canvas', version: '0.1.0' });
const host = createMcpHost(app);
const renderer = mountCanvasRenderer({
  host,
  viewportEl,
  worldEl,
  edgesEl,
  zoomControlsEl,
});

void bootstrap();

async function bootstrap(): Promise<void> {
  await app.connect();
  try {
    const doc = await host.loadDocument();
    renderer.applyDocument(doc, 'Ready');
  } catch (error) {
    console.error(
      error instanceof Error ? `Connected — ${error.message}` : 'Connected — error',
    );
  }
}
