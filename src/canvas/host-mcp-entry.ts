import { App } from '@modelcontextprotocol/ext-apps';

import './styles.css';
import { createMcpHost } from './host-mcp';
import { mountCanvasRenderer } from './render';

const statusEl = document.getElementById('status')!;
const viewportEl = document.getElementById('viewport')!;
const worldEl = document.getElementById('world')!;
const edgesEl = document.getElementById('edges') as unknown as SVGSVGElement;
const zoomControlsEl = document.getElementById('zoom-controls');

const app = new App({ name: 'spatial-design-canvas', version: '0.1.0' });
const host = createMcpHost(app);
const renderer = mountCanvasRenderer({
  host,
  statusEl,
  viewportEl,
  worldEl,
  edgesEl,
  zoomControlsEl,
});

void bootstrap();

async function bootstrap(): Promise<void> {
  statusEl.textContent = 'Connecting to host…';
  await app.connect();
  statusEl.textContent = 'Loading canvas…';
  try {
    const doc = await host.loadDocument();
    renderer.applyDocument(doc, 'Ready');
  } catch (error) {
    statusEl.textContent =
      error instanceof Error ? `Connected — ${error.message}` : 'Connected — error';
  }
}
