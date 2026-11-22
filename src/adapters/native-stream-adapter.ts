import type { ViewportAdapter, ViewportContext } from './types';

/**
 * Stub for Sprint 7 — iOS Simulator / Android Emulator streams.
 * Same contract as WebIframeAdapter so ViewportNode can swap kinds later.
 */
export class NativeStreamAdapter implements ViewportAdapter {
  readonly kind = 'native-stream' as const;

  private host: HTMLElement | null = null;

  mount(host: HTMLElement, _context: ViewportContext): void {
    this.unmount();
    this.host = host;
    host.replaceChildren();
    host.classList.add('viewport-adapter', 'viewport-adapter--native');

    const placeholder = document.createElement('div');
    placeholder.className = 'viewport-adapter-status';
    placeholder.textContent = 'NativeStreamAdapter — Sprint 7 (iOS / Android streams)';
    host.appendChild(placeholder);
  }

  unmount(): void {
    if (this.host) {
      this.host.replaceChildren();
      this.host.classList.remove('viewport-adapter', 'viewport-adapter--native');
      this.host = null;
    }
  }
}
