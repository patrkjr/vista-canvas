import { nativeFrame, type ViewportAdapter, type ViewportContext } from './types';

/**
 * Meso overview still — skeleton until a 2× WebP URL is ready.
 * Never boots the target app in the canvas tab.
 */
export class SnapshotAdapter implements ViewportAdapter {
  readonly kind = 'snapshot' as const;

  private host: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private img: HTMLImageElement | null = null;
  private skeletonEl: HTMLElement | null = null;
  private mountedKey: string | null = null;

  mount(host: HTMLElement, context: ViewportContext): void {
    this.unmount();
    this.host = host;
    host.replaceChildren();
    host.classList.add('viewport-adapter', 'viewport-adapter--snapshot');

    const frame = nativeFrame(context.frame);
    host.style.setProperty('--iframe-frame-width', `${frame.width}px`);
    host.style.setProperty('--iframe-frame-height', `${frame.height}px`);

    const skeleton = document.createElement('div');
    skeleton.className = 'viewport-snapshot-skeleton';
    skeleton.setAttribute('aria-hidden', 'true');
    this.skeletonEl = skeleton;
    host.appendChild(skeleton);

    const status = document.createElement('div');
    status.className = 'viewport-adapter-status';
    status.hidden = true;
    this.statusEl = status;
    host.appendChild(status);

    const img = document.createElement('img');
    img.className = 'viewport-snapshot';
    img.alt = context.title;
    img.draggable = false;
    img.decoding = 'async';
    this.img = img;
    host.appendChild(img);

    this.apply(context);
  }

  /** Update still URL / error without remounting the skeleton chrome. */
  update(context: ViewportContext): void {
    if (!this.host) {
      // Caller should mount first; tolerate a late update.
      return;
    }
    this.apply(context);
  }

  unmount(): void {
    this.statusEl = null;
    this.img = null;
    this.skeletonEl = null;
    this.mountedKey = null;
    if (this.host) {
      this.host.replaceChildren();
      this.host.classList.remove('viewport-adapter', 'viewport-adapter--snapshot');
      this.host.style.removeProperty('--iframe-frame-width');
      this.host.style.removeProperty('--iframe-frame-height');
      this.host = null;
    }
  }

  private apply(context: ViewportContext): void {
    const key = `${context.snapshotUrl ?? ''}|${context.snapshotError ?? ''}`;
    if (key === this.mountedKey) return;
    this.mountedKey = key;

    const img = this.img;
    const status = this.statusEl;
    const skeleton = this.skeletonEl;
    if (!img || !status || !skeleton) return;

    if (context.snapshotError) {
      img.removeAttribute('src');
      img.classList.remove('is-loaded');
      skeleton.hidden = true;
      status.hidden = false;
      status.textContent =
        context.snapshotError ||
        `Preview unavailable\n(${context.previewUrl})`;
      return;
    }

    status.hidden = true;

    if (!context.snapshotUrl) {
      img.removeAttribute('src');
      img.classList.remove('is-loaded');
      skeleton.hidden = false;
      return;
    }

    skeleton.hidden = false;
    img.classList.remove('is-loaded');
    img.onload = () => {
      img.classList.add('is-loaded');
      skeleton.hidden = true;
    };
    img.onerror = () => {
      img.classList.remove('is-loaded');
      skeleton.hidden = true;
      status.hidden = false;
      status.textContent = `Preview unavailable\n(${context.previewUrl})`;
    };
    if (img.src !== context.snapshotUrl) {
      img.src = context.snapshotUrl;
    } else if (img.complete && img.naturalWidth > 0) {
      img.classList.add('is-loaded');
      skeleton.hidden = true;
    }
  }
}
