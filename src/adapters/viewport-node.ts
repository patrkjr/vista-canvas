import type { SemanticZoomLevel } from '../types/domain';
import { NativeStreamAdapter } from './native-stream-adapter';
import { SnapshotAdapter } from './snapshot-adapter';
import {
  NODE_SIZES,
  WORKSPACE_SIZE,
  mesoBoxSize,
  nativeFrame,
  type NodeBoxSize,
  type ViewportAdapter,
  type ViewportContext,
} from './types';
import { WebIframeAdapter } from './web-iframe-adapter';

/** Reserved for Sprint 7 — keep the stub constructible beside WebIframeAdapter. */
export function createNativeStreamAdapter(): ViewportAdapter {
  return new NativeStreamAdapter();
}

export interface ViewportNodeChrome {
  readonly title: string;
  readonly route: string;
  /** MFE ownership badge (macro card). */
  readonly mfe: string;
  /**
   * Floating label above the card.
   * Overview: screen title. Focus: variant name (Default / fixture title).
   */
  readonly chromeLabel: string;
  readonly dataScreen?: string;
}

export interface ViewportNodeDragHandlers {
  onSelect: (nodeId: string) => void;
  onFocus: (nodeId: string) => void;
  /** World-space pointer down — return false to skip drag. */
  onDragBegin?: (nodeId: string, event: PointerEvent) => boolean;
  onDragMove?: (nodeId: string, clientX: number, clientY: number) => void;
  onDragEnd?: (nodeId: string, didMove: boolean) => void;
}

export interface ViewportNodeHandle {
  readonly root: HTMLElement;
  readonly width: number;
  readonly height: number;
  updateChrome(chrome: ViewportNodeChrome, isSelected: boolean): void;
  setPosition(x: number, y: number): void;
  setFocused(isFocused: boolean): void;
  setDimmed(isDimmed: boolean): void;
  setDragging(isDragging: boolean): void;
  /** Native iframe size used for meso/focus scale (screens default to 1280×800). */
  setNativeFrame(frame: NodeBoxSize): void;
  /** Size/position in world space and set iframe scale (no remount). */
  layoutInWorld(
    rect: { x: number; y: number; width: number; height: number },
    iframeScale: number
  ): void;
  setScreenRect(rect: { left: number; top: number; width: number; height: number } | null): void;
  invalidateMount(): void;
  syncAdapter(level: SemanticZoomLevel, context: ViewportContext | null): void;
  destroy(): void;
}

const DRAG_THRESHOLD_PX = 5;

/**
 * Canvas screen chrome + optional live adapter mount.
 * Macro: chrome only. Meso: non-interactive overview. Focused: interactive workspace.
 * Root is a div (not a button) so focused iframes are not nested in a control.
 */
export function createViewportNode(
  nodeId: string,
  handlers: ViewportNodeDragHandlers
): ViewportNodeHandle {
  const root = document.createElement('div');
  root.className = 'node';
  root.dataset.nodeId = nodeId;
  root.tabIndex = 0;
  root.setAttribute('role', 'button');

  const headerEl = document.createElement('header');
  headerEl.className = 'node-header';

  const titleEl = document.createElement('h2');
  titleEl.className = 'node-title';
  headerEl.append(titleEl);

  const screenTitleEl = document.createElement('h2');
  screenTitleEl.className = 'node-screen-title';

  const metaEl = document.createElement('div');
  metaEl.className = 'node-meta';
  const routeEl = document.createElement('span');
  const screenEl = document.createElement('span');
  metaEl.append(routeEl, screenEl);

  const badgeEl = document.createElement('span');
  badgeEl.className = 'node-badge';

  const mountEl = document.createElement('div');
  mountEl.className = 'node-mount';

  root.append(headerEl, screenTitleEl, metaEl, badgeEl, mountEl);

  let adapter: ViewportAdapter | null = null;
  let mountedUrl: string | null = null;
  let mountedMode: 'still' | 'live' | null = null;
  let isFocused = false;
  let width = NODE_SIZES.macro.width;
  let height = NODE_SIZES.macro.height;
  let nativeFrameSize: NodeBoxSize = WORKSPACE_SIZE;
  let dragPointerId: number | null = null;
  let dragStartX = 0;
  let dragStartY = 0;
  let didDrag = false;
  let suppressClick = false;

  root.addEventListener('pointerdown', (event) => {
    // Don't start Space-pan from the node.
    event.stopPropagation();
    if (isFocused || event.button !== 0) return;
    if ((event.target as HTMLElement).closest('.viewport-iframe')) return;

    const allowDrag = handlers.onDragBegin?.(nodeId, event) ?? true;
    if (!allowDrag) return;

    dragPointerId = event.pointerId;
    dragStartX = event.clientX;
    dragStartY = event.clientY;
    didDrag = false;
    root.setPointerCapture(event.pointerId);
  });

  root.addEventListener('pointermove', (event) => {
    if (dragPointerId !== event.pointerId) return;
    const dx = event.clientX - dragStartX;
    const dy = event.clientY - dragStartY;
    if (!didDrag && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    if (!didDrag) {
      didDrag = true;
      root.classList.add('is-dragging');
    }
    handlers.onDragMove?.(nodeId, event.clientX, event.clientY);
  });

  function endDrag(event: PointerEvent): void {
    if (dragPointerId !== event.pointerId) return;
    dragPointerId = null;
    root.classList.remove('is-dragging');
    if (didDrag) {
      suppressClick = true;
      handlers.onDragEnd?.(nodeId, true);
      didDrag = false;
      return;
    }
    handlers.onDragEnd?.(nodeId, false);
  }

  root.addEventListener('pointerup', endDrag);
  root.addEventListener('pointercancel', endDrag);

  root.addEventListener('click', (event) => {
    if (isFocused) return;
    if (suppressClick) {
      suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    // Ignore the second click of a double-click so we don't race select + focus writes.
    if (event.detail > 1) return;
    if ((event.target as HTMLElement).closest('.viewport-iframe')) return;
    event.stopPropagation();
    handlers.onSelect(nodeId);
  });

  root.addEventListener('dblclick', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (suppressClick || didDrag) return;
    handlers.onFocus(nodeId);
  });

  root.addEventListener('keydown', (event) => {
    if (isFocused) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handlers.onSelect(nodeId);
    }
  });

  function applyFrameVars(frame: NodeBoxSize, scale: number): void {
    root.style.setProperty('--iframe-frame-width', `${frame.width}px`);
    root.style.setProperty('--iframe-frame-height', `${frame.height}px`);
    root.style.setProperty('--iframe-scale', String(scale));
    const iframe = root.querySelector<HTMLIFrameElement>('iframe');
    if (iframe) {
      iframe.style.width = `${frame.width}px`;
      iframe.style.height = `${frame.height}px`;
      iframe.style.transform = `scale(${scale})`;
    }
    const snapshot = root.querySelector<HTMLImageElement>('img.viewport-snapshot');
    if (snapshot) {
      snapshot.style.width = `${frame.width}px`;
      snapshot.style.height = `${frame.height}px`;
      snapshot.style.transform = `scale(${scale})`;
    }
  }

  function applyOverviewSize(level: SemanticZoomLevel): void {
    const overviewLevel = level === 'macro' ? 'macro' : 'meso';
    const size = overviewLevel === 'macro' ? NODE_SIZES.macro : mesoBoxSize(nativeFrameSize);
    width = size.width;
    height = size.height;
    root.style.width = `${size.width}px`;
    root.style.height = `${size.height}px`;
    applyFrameVars(nativeFrameSize, size.width / nativeFrameSize.width);
    root.dataset.zoomLevel = overviewLevel;
  }

  applyOverviewSize('macro');

  return {
    root,
    get width() {
      return width;
    },
    get height() {
      return height;
    },

    updateChrome(chrome, isSelected) {
      titleEl.textContent = chrome.chromeLabel;
      root.dataset.chromeLabel = chrome.chromeLabel;
      screenTitleEl.textContent = chrome.title;
      routeEl.textContent = chrome.route;
      screenEl.textContent = chrome.dataScreen ?? nodeId;
      badgeEl.textContent = chrome.mfe;
      root.classList.toggle('is-selected', isSelected);
    },

    setPosition(x, y) {
      if (root.classList.contains('is-on-sheet') || root.classList.contains('is-focus-variant')) {
        return;
      }
      if (isFocused) return;
      root.style.left = `${x}px`;
      root.style.top = `${y}px`;
    },

    setFocused(nextFocused) {
      isFocused = nextFocused;
      root.classList.toggle('is-focused', nextFocused);
      if (nextFocused) {
        root.removeAttribute('role');
        root.tabIndex = -1;
      } else {
        root.setAttribute('role', 'button');
        root.tabIndex = 0;
      }
    },

    setDimmed(isDimmed) {
      root.classList.toggle('is-dimmed', isDimmed);
    },

    setDragging(isDragging) {
      root.classList.toggle('is-dragging', isDragging);
    },

    setNativeFrame(frame) {
      nativeFrameSize = nativeFrame(frame);
      applyFrameVars(nativeFrameSize, width / nativeFrameSize.width);
    },

    layoutInWorld(rect, iframeScale) {
      root.classList.remove('is-on-sheet');
      root.style.position = 'absolute';
      root.style.left = `${rect.x}px`;
      root.style.top = `${rect.y}px`;
      root.style.width = `${rect.width}px`;
      root.style.height = `${rect.height}px`;
      root.style.right = 'auto';
      root.style.bottom = 'auto';
      root.style.transform = 'none';
      applyFrameVars(nativeFrameSize, iframeScale);
      root.dataset.zoomLevel = 'workspace';
      width = rect.width;
      height = rect.height;
    },

    setScreenRect(rect) {
      if (!rect) {
        root.classList.remove('is-on-sheet');
        root.style.position = '';
        root.style.left = '';
        root.style.top = '';
        root.style.width = '';
        root.style.height = '';
        root.style.right = '';
        root.style.bottom = '';
        root.style.transform = '';
        root.style.removeProperty('--iframe-scale');
        const iframe = root.querySelector<HTMLIFrameElement>('iframe');
        if (iframe) iframe.style.removeProperty('transform');
        return;
      }
      // Positioned on the new work canvas (parent = .focus-sheet).
      root.classList.add('is-on-sheet');
      root.style.position = 'absolute';
      root.style.left = `${rect.left}px`;
      root.style.top = `${rect.top}px`;
      root.style.width = `${rect.width}px`;
      root.style.height = `${rect.height}px`;
      root.style.right = 'auto';
      root.style.bottom = 'auto';
      root.style.transform = 'none';
      applyFrameVars(nativeFrameSize, rect.width / nativeFrameSize.width);
      width = rect.width;
      height = rect.height;
      root.dataset.zoomLevel = 'workspace';
    },

    invalidateMount() {
      adapter?.unmount();
      adapter = null;
      mountedUrl = null;
      mountedMode = null;
    },

    syncAdapter(level, context) {
      if (
        !isFocused &&
        !root.classList.contains('is-on-sheet') &&
        !root.classList.contains('is-focus-variant')
      ) {
        applyOverviewSize(level);
      }

      // Unmount when no context (macro overview siblings, or missing previewPath).
      if (!context) {
        adapter?.unmount();
        adapter = null;
        mountedUrl = null;
        mountedMode = null;
        mountEl.hidden = true;
        mountEl.replaceChildren();
        root.classList.remove('has-mount');
        return;
      }

      mountEl.hidden = false;
      root.classList.add('has-mount');

      const mode = context.mode ?? 'live';

      if (mode === 'still') {
        if (adapter instanceof SnapshotAdapter && mountedMode === 'still') {
          adapter.update(context);
          mountedUrl = context.previewUrl;
          return;
        }
        adapter?.unmount();
        const next = new SnapshotAdapter();
        next.mount(mountEl, context);
        adapter = next;
        mountedUrl = context.previewUrl;
        mountedMode = 'still';
        return;
      }

      // Live iframe path (focus / fixtures).
      const existingIframe = mountEl.querySelector('iframe');
      const sameUrl =
        mountedMode === 'live' &&
        (mountedUrl === context.previewUrl ||
          (existingIframe !== null && urlsMatch(existingIframe.src, context.previewUrl)));

      // Same URL already in the mount — keep Angular; never replaceChildren.
      if (sameUrl && existingIframe) {
        if (adapter instanceof WebIframeAdapter) {
          adapter.setInteractive(context.interactive);
        } else {
          const next = new WebIframeAdapter();
          next.adopt(mountEl, existingIframe, context.interactive);
          adapter = next;
        }
        mountedUrl = context.previewUrl;
        mountedMode = 'live';
        return;
      }

      adapter?.unmount();
      adapter = new WebIframeAdapter();
      adapter.mount(mountEl, context);
      mountedUrl = context.previewUrl;
      mountedMode = 'live';
    },

    destroy() {
      adapter?.unmount();
      adapter = null;
      mountedUrl = null;
      mountedMode = null;
      root.remove();
    },
  };
}

function urlsMatch(left: string, right: string): boolean {
  try {
    return new URL(left, 'http://localhost').href === new URL(right, 'http://localhost').href;
  } catch {
    return left === right;
  }
}
