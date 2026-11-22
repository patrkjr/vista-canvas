import { nativeFrame, type ViewportAdapter, type ViewportContext } from './types';

/**
 * Mounts a live web app route in an iframe.
 * No sandbox — Native Federation needs scripts and same-origin module loads.
 */
export class WebIframeAdapter implements ViewportAdapter {
  readonly kind = 'web-iframe' as const;

  private host: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private iframe: HTMLIFrameElement | null = null;
  private loadTimer: number | null = null;
  private readonly onError: (message: string) => void;

  constructor(onError?: (message: string) => void) {
    this.onError = onError ?? (() => undefined);
  }

  mount(host: HTMLElement, context: ViewportContext): void {
    this.unmount();
    this.host = host;
    host.replaceChildren();
    host.classList.add('viewport-adapter', 'viewport-adapter--iframe');

    const status = document.createElement('div');
    status.className = 'viewport-adapter-status';
    status.hidden = true;
    status.textContent = `Start mock-bank-mfe on :4200\n(${context.previewUrl})`;
    this.statusEl = status;
    host.appendChild(status);

    const iframe = document.createElement('iframe');
    iframe.className = 'viewport-iframe';
    iframe.title = context.title;
    iframe.src = context.previewUrl;
    iframe.loading = 'eager';
    iframe.style.pointerEvents = context.interactive ? 'auto' : 'none';
    const frame = nativeFrame(context.frame);
    iframe.style.width = `${frame.width}px`;
    iframe.style.height = `${frame.height}px`;
    this.iframe = iframe;
    iframe.addEventListener('load', () => {
      if (this.loadTimer !== null) {
        window.clearTimeout(this.loadTimer);
        this.loadTimer = null;
      }
      if (this.statusEl) this.statusEl.hidden = true;
      iframe.classList.add('is-loaded');
    });
    iframe.addEventListener('error', () => {
      this.showUnavailable(context.previewUrl);
    });

    // Soft timeout: if the bank isn't running, surface a hint (iframe may still hang).
    this.loadTimer = window.setTimeout(() => {
      if (!iframe.classList.contains('is-loaded')) {
        this.showUnavailable(context.previewUrl);
      }
    }, 4000);

    host.appendChild(iframe);
  }

  /** Bind to an iframe that is already in the mount (do not reload Angular). */
  adopt(host: HTMLElement, iframe: HTMLIFrameElement, interactive: boolean): void {
    this.host = host;
    this.iframe = iframe;
    this.statusEl = host.querySelector('.viewport-adapter-status');
    iframe.style.pointerEvents = interactive ? 'auto' : 'none';
  }

  /** Flip pointer-events without remounting (meso overview ↔ focused workspace). */
  setInteractive(interactive: boolean): void {
    if (this.iframe) {
      this.iframe.style.pointerEvents = interactive ? 'auto' : 'none';
    }
  }

  unmount(): void {
    if (this.loadTimer !== null) {
      window.clearTimeout(this.loadTimer);
      this.loadTimer = null;
    }
    this.statusEl = null;
    this.iframe = null;
    if (this.host) {
      this.host.replaceChildren();
      this.host.classList.remove('viewport-adapter', 'viewport-adapter--iframe');
      this.host = null;
    }
  }

  private showUnavailable(previewUrl: string): void {
    if (this.statusEl) {
      this.statusEl.hidden = false;
      this.statusEl.textContent = `Start mock-bank-mfe on :4200\n(${previewUrl})`;
    }
    this.onError(`Preview unavailable: ${previewUrl}`);
  }
}
