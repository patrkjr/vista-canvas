import { createViewportNode, type ViewportNodeHandle } from '../adapters/viewport-node';
import { mesoBoxSize, nativeFrame, overviewBoxSize } from '../adapters/types';
import { buildPreviewUrl, resolvePreviewPath } from '../adapters/preview-url';
import { mountEditComposer, type EditComposerHandle } from './edit-composer';
import {
  preferredColorScheme,
  SnapshotObjectCache,
  toSnapshotRequest,
  type SnapshotCacheKey,
} from './snapshot-cache';
import type {
  CanvasHost,
  CanvasNode,
  DesignCanvasDocument,
  SemanticZoomLevel,
} from './types';

const VIEW_DEBOUNCE_MS = 250;
/** Overview levels only — screen focus is a scene, not a toolbar zoom level. */
const SEMANTIC_LEVELS = ['macro', 'meso'] as const;
type OverviewLevel = (typeof SEMANTIC_LEVELS)[number];
/**
 * Dot grid LOD — single layer, power-of-two world step.
 * Holds on-screen gap inside [MIN, MAX] so density stays readable while zooming.
 */
const DOT_GRID_BASE = 24;
const DOT_GRID_MIN_SCREEN = 16;
const DOT_GRID_MAX_SCREEN = 36;
const MIN_ZOOM = 0.01; // 1%
const MAX_ZOOM = 5; // 500%
const ZOOM_STEP = 1.08;
/** Gap between the focused screen and its state cards. */
const STATE_GAP_PX = 28;
/** Fog fade + first state card. */
const FOCUS_TRANSITION_MS = 480;
/** Extra world padding when deciding which meso stills to prioritize. */
const SNAPSHOT_FRUSTUM_PAD_PX = 200;

export interface CanvasRendererOptions {
  host: CanvasHost;
  statusEl: HTMLElement;
  viewportEl: HTMLElement;
  worldEl: HTMLElement;
  edgesEl: SVGSVGElement;
  zoomControlsEl?: HTMLElement | null;
}

interface SdcGlobal {
  __sdcTeardown?: () => void;
  __sdcFocusPhase?: string;
}

const sdcGlobal = globalThis as typeof globalThis & SdcGlobal;

export function mountCanvasRenderer(options: CanvasRendererOptions): {
  applyDocument: (doc: DesignCanvasDocument, status: string) => void;
  destroy: () => void;
} {
  const { host, statusEl, viewportEl, worldEl, edgesEl, zoomControlsEl } = options;
  sdcGlobal.__sdcTeardown?.();

  let documentState: DesignCanvasDocument | null = null;
  let appOrigin = 'http://localhost:4200';
  /** Overview camera — never overwritten while focused. */
  let overviewPanX = 0;
  let overviewPanY = 0;
  let overviewZoom = 1;
  /** Visual camera — overview and focus share this. */
  let panX = 0;
  let panY = 0;
  let zoom = 1;
  let semanticLevel: OverviewLevel = 'macro';
  let focusedNodeId: string | null = null;
  let isPanning = false;
  let spaceHeld = false;
  let panPointerId: number | null = null;
  let panOriginX = 0;
  let panOriginY = 0;
  let panStartX = 0;
  let panStartY = 0;
  let viewPersistTimer: number | null = null;
  /** Clears compositor will-change after wheel/pan so snapshot layers re-raster at final zoom. */
  let cameraIdleTimer: number | null = null;
  let suppressViewPersist = false;
  let focusRaf = 0;
  let focusWaitResolve: (() => void) | null = null;
  let draggingNodeId: string | null = null;
  let dragOriginWorldX = 0;
  let dragOriginWorldY = 0;
  let dragPointerStartX = 0;
  let dragPointerStartY = 0;
  /** Skip the click that follows a pan/drag so empty-canvas unfocus stays intentional. */
  let suppressCanvasClick = false;
  /** Locks lift/lower so document updates cannot remount mid-animation. */
  let focusPhase: 'idle' | 'lifting' | 'open' | 'lowering' = 'idle';

  const dotsEl = ensureDotsLayer(viewportEl);
  const chromeLayerEl = ensureChromeLayer(viewportEl);
  const scrimEl = ensureFocusScrim(viewportEl);
  const focusFrontEl = ensureFocusFront(viewportEl);
  viewportEl.querySelector('.focus-sheet')?.remove();
  const backBtn = ensureBackButton(viewportEl);
  const zoomReadoutEl = ensureZoomReadout(viewportEl);
  const editComposer: EditComposerHandle | null =
    host.requestEdit && host.resetEdit
      ? mountEditComposer(viewportEl, {
          requestEdit: (prompt, nodeId) => host.requestEdit!(prompt, nodeId),
          resetEdit: () => host.resetEdit!(),
          ...(host.cancelEdit ? { cancelEdit: () => host.cancelEdit!() } : {}),
          ...(host.onEdit ? { onEdit: (handler) => host.onEdit!(handler) } : {}),
        })
      : null;
  const nodeHandles = new Map<string, ViewportNodeHandle>();
  const snapshotCache = new SnapshotObjectCache();
  const snapshotErrors = new Map<string, string>();
  let snapshotQueue: SnapshotCacheKey[] = [];
  let snapshotInFlight: string | null = null;
  let snapshotGeneration = 0;
  let colorScheme = preferredColorScheme();
  const colorSchemeQuery = window.matchMedia('(prefers-color-scheme: dark)');

  let acceptLiveUpdates = false;

  void host.getConfig().then((config) => {
    const nextOrigin = config.appOrigin;
    if (nextOrigin === appOrigin) return;
    appOrigin = nextOrigin;
    if (documentState) render();
  });

  function setStatus(message: string): void {
    statusEl.textContent = message;
  }

  function isFocused(): boolean {
    return focusedNodeId !== null;
  }

  function setFocusPhase(next: 'idle' | 'lifting' | 'open' | 'lowering'): void {
    focusPhase = next;
    viewportEl.dataset.focusPhase = next;
    sdcGlobal.__sdcFocusPhase = next;
    syncViewportFocusClass();
  }

  function sharedFocusPhase(): string {
    return sdcGlobal.__sdcFocusPhase ?? viewportEl.dataset.focusPhase ?? 'idle';
  }

  function applyDocument(doc: DesignCanvasDocument, status: string): void {
    const previousFocused = focusedNodeId;
    const wasFocused = previousFocused !== null;
    const nextFocused = doc.view.focusedNodeId;
    const enteringFocus = !wasFocused && nextFocused !== null;
    const exitingFocus = wasFocused && nextFocused === null;
    const switchingFocus =
      wasFocused && nextFocused !== null && nextFocused !== previousFocused;

    documentState = doc;
    suppressViewPersist = true;
    semanticLevel = coerceOverviewLevel(doc.view.semanticZoomLevel);
    focusedNodeId = nextFocused;

    // Overview pan/zoom in the document stay as the restored camera.
    overviewPanX = doc.view.pan.x;
    overviewPanY = doc.view.pan.y;
    overviewZoom = doc.view.zoom;

    if (focusPhase === 'idle') {
      panX = overviewPanX;
      panY = overviewPanY;
      zoom = overviewZoom;
    }

    syncZoomControls();
    syncBackButton();
    syncEditComposer();
    syncViewportFocusClass();
    syncZoomReadout();
    render();

    if (enteringFocus) {
      const rootId = resolveFocusRootId(nextFocused);
      if (rootId) void liftFocusedNode(rootId);
    } else if (switchingFocus) {
      const prevRoot = resolveFocusRootId(previousFocused);
      const nextRoot = resolveFocusRootId(nextFocused);
      if (prevRoot && nextRoot && prevRoot === nextRoot) {
        layoutFocusStates();
      } else {
        if (prevRoot) snapNodeHome(prevRoot);
        else if (previousFocused) snapNodeHome(previousFocused);
        hideAllFixtures();
        setFocusProgress(0);
        scrimEl.classList.remove('is-visible');
        setFocusPhase('idle');
        if (nextRoot) void liftFocusedNode(nextRoot);
      }
    } else if (exitingFocus) {
      void lowerFocusedNode(resolveFocusRootId(previousFocused) ?? previousFocused);
    } else if (nextFocused !== null && focusPhase === 'idle' && sharedFocusPhase() === 'idle') {
      const rootId = resolveFocusRootId(nextFocused);
      if (rootId) void liftFocusedNode(rootId, true);
    }

    suppressViewPersist = false;

    const focusLabel = nextFocused ? ` · focused ${nextFocused}` : '';
    setStatus(`${status} · ${doc.nodes.length} nodes · ${semanticLevel}${focusLabel}`);
    acceptLiveUpdates = true;
  }

  function resolveFocusRootId(nodeId: string | null | undefined): string | null {
    if (!nodeId || !documentState) return null;
    const node = documentState.nodes.find((n) => n.id === nodeId);
    if (!node) return null;
    if (node.kind === 'fixture') return node.parentId ?? null;
    return node.id;
  }

  function fixturesForScreen(screenId: string): CanvasNode[] {
    if (!documentState) return [];
    return documentState.nodes.filter(
      (node) => node.kind === 'fixture' && node.parentId === screenId
    );
  }

  function markCameraMoving(): void {
    worldEl.style.willChange = 'transform';
    edgesEl.style.willChange = 'transform';
    focusFrontEl.style.willChange = 'transform';
    if (cameraIdleTimer !== null) window.clearTimeout(cameraIdleTimer);
    cameraIdleTimer = window.setTimeout(releaseCameraLayer, 140);
  }

  function releaseCameraLayer(): void {
    cameraIdleTimer = null;
    worldEl.style.willChange = 'auto';
    edgesEl.style.willChange = 'auto';
    focusFrontEl.style.willChange = 'auto';
  }

  function syncZoomReadout(): void {
    zoomReadoutEl.textContent = `${Math.round(zoom * 100)}%`;
  }

  function prefersReducedMotion(): boolean {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function setFocusProgress(t: number): void {
    viewportEl.style.setProperty('--focus-t', String(clamp(t, 0, 1)));
  }

  function cancelFocusAnimation(): void {
    if (focusRaf) {
      cancelAnimationFrame(focusRaf);
      focusRaf = 0;
    }
    const resolve = focusWaitResolve;
    focusWaitResolve = null;
    resolve?.();
  }

  function easeOutFocus(t: number): number {
    return 1 - (1 - t) ** 3;
  }

  function panToCenterNode(node: CanvasNode): { x: number; y: number } {
    const size = overviewBoxSize(semanticLevel, node.frame);
    const vp = viewportEl.getBoundingClientRect();
    const worldCx = node.position.x + size.width / 2;
    const worldCy = node.position.y + size.height / 2;
    return {
      x: vp.width / 2 - worldCx * zoom,
      y: vp.height / 2 - worldCy * zoom,
    };
  }

  function animatePanTo(targetX: number, targetY: number): Promise<void> {
    cancelFocusAnimation();
    const fromX = panX;
    const fromY = panY;
    const duration = prefersReducedMotion() ? 0 : FOCUS_TRANSITION_MS;

    const apply = (u: number): void => {
      const e = easeOutFocus(u);
      panX = fromX + (targetX - fromX) * e;
      panY = fromY + (targetY - fromY) * e;
      renderTransformOnly();
    };

    if (duration <= 0) {
      apply(1);
      return Promise.resolve();
    }

    markCameraMoving();
    return new Promise((resolve) => {
      focusWaitResolve = resolve;
      const start = performance.now();
      const tick = (now: number): void => {
        const u = Math.min(1, (now - start) / duration);
        apply(u);
        if (u < 1) {
          focusRaf = requestAnimationFrame(tick);
          return;
        }
        focusRaf = 0;
        focusWaitResolve = null;
        releaseCameraLayer();
        resolve();
      };
      focusRaf = requestAnimationFrame(tick);
    });
  }

  function raiseToFront(handle: ViewportNodeHandle): void {
    handle.root.classList.add('is-focus-raised');
    handle.setDimmed(false);
    if (handle.root.parentElement !== focusFrontEl) {
      focusFrontEl.appendChild(handle.root);
    }
  }

  function snapNodeHome(nodeId: string): void {
    const handle = nodeHandles.get(nodeId);
    if (!handle) return;
    handle.root.classList.remove(
      'is-focus-raised',
      'is-state-enter',
      'is-state-leave',
      'is-focus-variant',
      'is-on-sheet',
      'is-lifting'
    );
    handle.root.style.removeProperty('--stagger');
    handle.setFocused(false);
    handle.setScreenRect(null);
    if (handle.root.parentElement !== worldEl) worldEl.appendChild(handle.root);
    const node = documentState?.nodes.find((n) => n.id === nodeId);
    if (node) handle.setPosition(node.position.x, node.position.y);
  }

  function hideFixtureNode(handle: ViewportNodeHandle): void {
    handle.root.classList.add('is-fixture-hidden');
    handle.root.classList.remove(
      'is-focus-raised',
      'is-state-enter',
      'is-state-leave',
      'is-focus-variant',
      'is-selected',
      'is-on-sheet'
    );
    handle.root.style.removeProperty('--stagger');
    handle.setFocused(false);
    handle.setDimmed(false);
    handle.setScreenRect(null);
    if (handle.root.parentElement !== worldEl) worldEl.appendChild(handle.root);
    handle.syncAdapter('macro', null);
  }

  function hideAllFixtures(): void {
    if (!documentState) return;
    for (const node of documentState.nodes) {
      if (node.kind !== 'fixture') continue;
      const handle = nodeHandles.get(node.id);
      if (handle) hideFixtureNode(handle);
    }
  }

  function stateSlot(
    root: CanvasNode,
    index: number
  ): { x: number; y: number; width: number; height: number } {
    const size = overviewBoxSize(semanticLevel, root.frame);
    return {
      x: root.position.x + size.width + STATE_GAP_PX + index * (size.width + STATE_GAP_PX),
      y: root.position.y,
      width: size.width,
      height: size.height,
    };
  }

  function syncMesoStill(node: CanvasNode, handle: ViewportNodeHandle): void {
    const previewPath = resolvePreviewPath(node.route, node.previewPath);
    if (semanticLevel === 'macro' || !previewPath) {
      handle.syncAdapter('macro', null);
      return;
    }
    const frame = nativeFrame(node.frame);
    const snapKey = snapshotKeyForNode(node);
    const snapId = snapKey ? SnapshotObjectCache.keyOf(snapKey) : null;
    const cachedUrl = snapKey ? snapshotCache.get(snapKey) : null;
    const snapError = snapId ? snapshotErrors.get(snapId) : undefined;
    handle.syncAdapter('meso', {
      nodeId: node.id,
      title: node.title,
      previewUrl: buildPreviewUrl(appOrigin, previewPath),
      semanticZoomLevel: 'meso',
      interactive: false,
      mode: 'still',
      frame,
      snapshotUrl: cachedUrl,
      snapshotError: snapError
        ? `Start mock-bank-mfe on :4200\n(${buildPreviewUrl(appOrigin, previewPath)})`
        : null,
    });
  }

  function layoutFocusStates(options?: { stagger?: boolean }): void {
    if (!documentState) return;
    const rootId = resolveFocusRootId(focusedNodeId);
    const show = rootId !== null && focusPhase !== 'idle';

    for (const node of documentState.nodes) {
      if (node.kind !== 'fixture') continue;
      const handle = nodeHandles.get(node.id);
      if (!handle) continue;
      if (!show || node.parentId !== rootId) hideFixtureNode(handle);
    }

    if (!show || !rootId) return;
    const root = documentState.nodes.find((n) => n.id === rootId);
    const rootHandle = nodeHandles.get(rootId);
    if (!root || !rootHandle) return;

    raiseToFront(rootHandle);
    rootHandle.setFocused(false);
    rootHandle.setPosition(root.position.x, root.position.y);

    const selectedId = documentState.view.selectedNodeId;
    const fixtures = fixturesForScreen(rootId);

    fixtures.forEach((node, index) => {
      const handle = nodeHandles.get(node.id);
      if (!handle) return;

      handle.root.classList.remove('is-fixture-hidden');
      raiseToFront(handle);
      const slot = stateSlot(root, index);
      handle.setNativeFrame(nativeFrame(node.frame));
      handle.setPosition(slot.x, slot.y);
      handle.updateChrome(
        {
          title: node.title,
          route: node.fixture ?? node.route,
          mfe: node.mfe,
          chromeLabel: node.title,
          ...(node.dataScreen !== undefined ? { dataScreen: node.dataScreen } : {}),
        },
        node.id === focusedNodeId || node.id === selectedId
      );
      syncMesoStill(node, handle);

      if (options?.stagger && !prefersReducedMotion()) {
        handle.root.style.setProperty('--stagger', String(index));
        handle.root.classList.remove('is-state-enter', 'is-state-leave');
        void handle.root.offsetWidth;
        handle.root.classList.add('is-state-enter');
      } else if (!handle.root.classList.contains('is-state-enter')) {
        handle.root.classList.remove('is-state-leave');
      }
    });

    syncChromeLabels();
  }

  async function liftFocusedNode(nodeId: string, instant = false): Promise<void> {
    const handle = nodeHandles.get(nodeId);
    if (!handle) return;
    const shared = sharedFocusPhase();
    if (focusPhase === 'lifting' || focusPhase === 'open' || shared === 'lifting' || shared === 'open') {
      return;
    }

    const liftingNode = documentState?.nodes.find((n) => n.id === nodeId);
    if (!liftingNode) return;

    cancelFocusAnimation();
    setFocusPhase('lifting');
    handle.setDimmed(false);
    raiseToFront(handle);
    scrimEl.classList.add('is-visible');

    const centered = panToCenterNode(liftingNode);

    if (instant) {
      viewportEl.classList.add('is-focus-instant');
      panX = centered.x;
      panY = centered.y;
      renderTransformOnly();
      setFocusProgress(1);
      layoutFocusStates();
      void viewportEl.offsetWidth;
      viewportEl.classList.remove('is-focus-instant');
      setFocusPhase('open');
      return;
    }

    setFocusProgress(1);
    layoutFocusStates({ stagger: true });
    await animatePanTo(centered.x, centered.y);

    if (
      viewportEl.dataset.focusPhase !== 'lifting' ||
      resolveFocusRootId(focusedNodeId) !== nodeId
    ) {
      return;
    }

    setFocusPhase('open');
  }

  async function lowerFocusedNode(nodeId: string | null): Promise<void> {
    cancelFocusAnimation();
    setFocusPhase('lowering');

    if (documentState) {
      for (const node of documentState.nodes) {
        if (node.kind !== 'fixture') continue;
        const fixtureHandle = nodeHandles.get(node.id);
        if (!fixtureHandle || node.parentId !== nodeId) continue;
        fixtureHandle.root.classList.remove('is-state-enter');
        fixtureHandle.root.classList.add('is-state-leave');
      }
    }

    setFocusProgress(0);
    const restoreX = overviewPanX;
    const restoreY = overviewPanY;

    if (!nodeId || !documentState) {
      panX = restoreX;
      panY = restoreY;
      renderTransformOnly();
      hideAllFixtures();
      scrimEl.classList.remove('is-visible');
      setFocusPhase('idle');
      return;
    }

    await animatePanTo(restoreX, restoreY);
    if (focusPhase !== 'lowering') return;

    hideAllFixtures();
    snapNodeHome(nodeId);
    scrimEl.classList.remove('is-visible');
    setFocusPhase('idle');
    render();
  }

  function redrawEdges(): void {
    if (!documentState) return;
    const activeFocusId = focusedNodeId;
    const nodesById = new Map(documentState.nodes.map((node) => [node.id, node]));
    const edgeFragments: string[] = [];
    const edgesDimmed = activeFocusId !== null;
    for (const edge of documentState.edges) {
      const from = nodesById.get(edge.from);
      const to = nodesById.get(edge.to);
      if (!from || !to || from.kind === 'fixture' || to.kind === 'fixture') continue;
      const fromHandle = nodeHandles.get(edge.from);
      const toHandle = nodeHandles.get(edge.to);
      if (!fromHandle || !toHandle) continue;

      const fromOverview = overviewBoxSize(semanticLevel, from.frame);
      const toOverview = overviewBoxSize(semanticLevel, to.frame);
      const fromW = activeFocusId === from.id ? fromOverview.width : fromHandle.width;
      const fromH = activeFocusId === from.id ? fromOverview.height : fromHandle.height;
      const toH = activeFocusId === to.id ? toOverview.height : toHandle.height;

      // Edges always connect overview positions (focused node is portaled away).
      const x1 = from.position.x + fromW;
      const y1 = from.position.y + fromH / 2;
      const x2 = to.position.x;
      const y2 = to.position.y + toH / 2;
      const midX = (x1 + x2) / 2;
      const midY = (y1 + y2) / 2;
      const kind = edge.kind ?? 'flow';
      const kindClass = kind === 'nav' ? ' is-nav' : '';

      edgeFragments.push(
        `<path class="edge-line${edgesDimmed ? ' is-dimmed' : ''}${kindClass}" d="M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}" />`
      );
      if (edge.label) {
        edgeFragments.push(
          `<text class="edge-label${edgesDimmed ? ' is-dimmed' : ''}" x="${midX}" y="${midY - 8}" text-anchor="middle">${escapeXml(edge.label)}</text>`
        );
      }
    }
    edgesEl.innerHTML = edgeFragments.join('');
  }

  function render(): void {
    if (!documentState) return;

    const selectedId = documentState.view.selectedNodeId;
    const activeFocusId = focusedNodeId;
    const focusRootId = resolveFocusRootId(activeFocusId);
    const seen = new Set<string>();

    for (const node of documentState.nodes) {
      seen.add(node.id);
      let handle = nodeHandles.get(node.id);
      if (!handle) {
        handle = createViewportNode(node.id, {
          onSelect: (id) => {
            void selectNode(id);
          },
          onFocus: (id) => {
            void focusNode(id);
          },
          onDragBegin: (id, event) => {
            if (isFocused() || spaceHeld) return false;
            const current = documentState?.nodes.find((n) => n.id === id);
            if (!current || current.kind === 'fixture') return false;
            draggingNodeId = id;
            dragOriginWorldX = current.position.x;
            dragOriginWorldY = current.position.y;
            dragPointerStartX = event.clientX;
            dragPointerStartY = event.clientY;
            return true;
          },
          onDragMove: (id, clientX, clientY) => {
            if (draggingNodeId !== id || !documentState) return;
            const dx = (clientX - dragPointerStartX) / zoom;
            const dy = (clientY - dragPointerStartY) / zoom;
            const nextX = dragOriginWorldX + dx;
            const nextY = dragOriginWorldY + dy;
            const nodes = documentState.nodes.map((n) =>
              n.id === id ? { ...n, position: { x: nextX, y: nextY } } : n
            );
            documentState = { ...documentState, nodes };
            const h = nodeHandles.get(id);
            h?.setPosition(nextX, nextY);
            h?.setDragging(true);
            redrawEdges();
            syncChromeLabels();
          },
          onDragEnd: (id, didMove) => {
            const h = nodeHandles.get(id);
            h?.setDragging(false);
            draggingNodeId = null;
            if (!didMove || !documentState) return;
            const dragged = documentState.nodes.find((n) => n.id === id);
            if (!dragged) return;
            void persistNodePosition(id, dragged.position.x, dragged.position.y);
          },
        });
        nodeHandles.set(node.id, handle);
        worldEl.appendChild(handle.root);
      }

      handle.setNativeFrame(nativeFrame(node.frame));
      handle.root.dataset.nodeKind = node.kind;

      // Fixtures are hidden in overview; layoutFocusStates owns them while focused.
      if (node.kind === 'fixture') {
        if (focusPhase === 'idle' || node.parentId !== focusRootId) {
          hideFixtureNode(handle);
        }
        continue;
      }

      const nodeIsRaised = focusRootId === node.id && focusPhase !== 'idle';
      if (nodeIsRaised) raiseToFront(handle);

      handle.updateChrome(
        {
          title: node.title,
          route: node.route,
          mfe: node.mfe,
          chromeLabel: node.title,
          ...(node.dataScreen !== undefined ? { dataScreen: node.dataScreen } : {}),
        },
        node.id === selectedId || (activeFocusId !== null && node.id === focusRootId)
      );

      handle.setFocused(false);
      handle.root.classList.remove('is-focus-variant', 'is-fixture-hidden');
      handle.setDimmed(false);
      if (draggingNodeId !== node.id) {
        handle.setPosition(node.position.x, node.position.y);
      }

      const previewPath = resolvePreviewPath(node.route, node.previewPath);
      if (semanticLevel === 'macro' || !previewPath) {
        handle.syncAdapter('macro', null);
      } else {
        const frame = nativeFrame(node.frame);
        const snapKey = snapshotKeyForNode(node);
        const snapId = snapKey ? SnapshotObjectCache.keyOf(snapKey) : null;
        const cachedUrl = snapKey ? snapshotCache.get(snapKey) : null;
        const snapError = snapId ? snapshotErrors.get(snapId) : undefined;
        handle.syncAdapter('meso', {
          nodeId: node.id,
          title: node.title,
          previewUrl: buildPreviewUrl(appOrigin, previewPath),
          semanticZoomLevel: 'meso',
          interactive: false,
          mode: 'still',
          frame,
          snapshotUrl: cachedUrl,
          snapshotError: snapError
            ? `Start mock-bank-mfe on :4200\n(${buildPreviewUrl(appOrigin, previewPath)})`
            : null,
        });
      }
    }

    for (const [id, handle] of nodeHandles) {
      if (seen.has(id)) continue;
      handle.destroy();
      nodeHandles.delete(id);
    }

    renderTransformOnly();
    redrawEdges();
    if (focusPhase === 'lifting' || focusPhase === 'open') layoutFocusStates();
    scheduleMesoSnapshots();
  }

  function snapshotKeyForNode(node: CanvasNode): SnapshotCacheKey | null {
    const path = resolvePreviewPath(node.route, node.previewPath);
    if (!path) return null;
    const frame = nativeFrame(node.frame);
    return {
      path,
      width: frame.width,
      height: frame.height,
      colorScheme,
    };
  }

  function worldFrustum(): { left: number; top: number; right: number; bottom: number } {
    const vp = viewportEl.getBoundingClientRect();
    const pad = SNAPSHOT_FRUSTUM_PAD_PX;
    return {
      left: (-panX - pad) / zoom,
      top: (-panY - pad) / zoom,
      right: (-panX + vp.width + pad) / zoom,
      bottom: (-panY + vp.height + pad) / zoom,
    };
  }

  function nodeInFrustum(
    node: CanvasNode,
    size: { width: number; height: number },
    frustum: { left: number; top: number; right: number; bottom: number }
  ): boolean {
    const x0 = node.position.x;
    const y0 = node.position.y;
    const x1 = x0 + size.width;
    const y1 = y0 + size.height;
    return x0 < frustum.right && x1 > frustum.left && y0 < frustum.bottom && y1 > frustum.top;
  }

  /** Priority queue: on-camera stills first, then idle prefetch of the rest. */
  function scheduleMesoSnapshots(): void {
    if (semanticLevel !== 'meso' || focusPhase === 'lowering') return;
    if (!documentState || !host.getSnapshot) return;

    const frustum = worldFrustum();
    const visible: SnapshotCacheKey[] = [];
    const rest: SnapshotCacheKey[] = [];
    const seen = new Set<string>();

    for (const node of documentState.nodes) {
      if (node.kind === 'fixture') {
        const handle = nodeHandles.get(node.id);
        if (!handle || handle.root.classList.contains('is-fixture-hidden')) continue;
      }
      const key = snapshotKeyForNode(node);
      if (!key) continue;
      const id = SnapshotObjectCache.keyOf(key);
      if (seen.has(id)) continue;
      seen.add(id);
      const size = mesoBoxSize(node.frame);
      if (nodeInFrustum(node, size, frustum)) visible.push(key);
      else rest.push(key);
    }

    snapshotQueue = [...visible, ...rest];
    void pumpSnapshotQueue();
  }

  async function pumpSnapshotQueue(): Promise<void> {
    if (snapshotInFlight !== null) return;
    if (!host.getSnapshot) return;

    while (snapshotQueue.length > 0) {
      if (semanticLevel !== 'meso' || focusPhase === 'lowering') return;

      const next = snapshotQueue.shift();
      if (!next) return;
      const id = SnapshotObjectCache.keyOf(next);

      if (snapshotCache.has(next) || snapshotErrors.has(id)) {
        applySnapshotToMatchingNodes(next);
        continue;
      }

      snapshotInFlight = id;
      const gen = snapshotGeneration;
      let stale = false;
      try {
        const blob = await host.getSnapshot(toSnapshotRequest(next));
        if (gen !== snapshotGeneration) {
          stale = true;
        } else {
          snapshotCache.put(next, blob);
          snapshotErrors.delete(id);
          applySnapshotToMatchingNodes(next);
        }
      } catch (error) {
        if (gen !== snapshotGeneration) {
          stale = true;
        } else {
          snapshotErrors.set(id, errorMessage(error));
          applySnapshotToMatchingNodes(next);
        }
      } finally {
        snapshotInFlight = null;
      }
      if (stale) {
        void pumpSnapshotQueue();
        return;
      }
    }
  }

  function applySnapshotToMatchingNodes(key: SnapshotCacheKey): void {
    if (!documentState || semanticLevel !== 'meso') return;
    const keyId = SnapshotObjectCache.keyOf(key);
    const cachedUrl = snapshotCache.get(key);
    const snapError = snapshotErrors.get(keyId);

    for (const node of documentState.nodes) {
      if (node.kind === 'fixture') {
        const fixtureHandle = nodeHandles.get(node.id);
        if (!fixtureHandle || fixtureHandle.root.classList.contains('is-fixture-hidden')) continue;
      }
      const nodeKey = snapshotKeyForNode(node);
      if (!nodeKey || SnapshotObjectCache.keyOf(nodeKey) !== keyId) continue;
      const handle = nodeHandles.get(node.id);
      const previewPath = resolvePreviewPath(node.route, node.previewPath);
      if (!handle || !previewPath) continue;
      handle.syncAdapter('meso', {
        nodeId: node.id,
        title: node.title,
        previewUrl: buildPreviewUrl(appOrigin, previewPath),
        semanticZoomLevel: 'meso',
        interactive: false,
        mode: 'still',
        frame: nativeFrame(node.frame),
        snapshotUrl: cachedUrl,
        snapshotError: snapError
          ? `Start mock-bank-mfe on :4200\n(${buildPreviewUrl(appOrigin, previewPath)})`
          : null,
      });
    }
  }

  function onColorSchemeChange(): void {
    const next = preferredColorScheme();
    if (next === colorScheme) return;
    colorScheme = next;
    snapshotGeneration += 1;
    snapshotQueue = [];
    snapshotCache.clear();
    snapshotErrors.clear();
    if (documentState && semanticLevel === 'meso') {
      render();
    }
  }

  async function persistNodePosition(nodeId: string, x: number, y: number): Promise<void> {
    setStatus(`Moving ${nodeId}…`);
    try {
      const doc = await host.moveNode(nodeId, { x, y });
      // Keep local drag position if a newer drag started.
      if (draggingNodeId === nodeId) return;
      applyDocument(doc, `Moved ${nodeId}`);
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }

  async function selectNode(nodeId: string): Promise<void> {
    if (isFocused()) {
      const rootId = resolveFocusRootId(focusedNodeId);
      const node = documentState?.nodes.find((n) => n.id === nodeId);
      if (
        node &&
        rootId &&
        (node.id === rootId || (node.kind === 'fixture' && node.parentId === rootId))
      ) {
        void focusNode(nodeId);
      }
      return;
    }
    const node = documentState?.nodes.find((n) => n.id === nodeId);
    if (node?.kind === 'fixture') {
      void focusNode(nodeId);
      return;
    }
    setStatus(`Selecting ${nodeId}…`);
    try {
      const doc = await host.selectNode(nodeId);
      applyDocument(doc, `Selected ${nodeId}`);
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }

  async function focusNode(nodeId: string): Promise<void> {
    setStatus(`Focusing ${nodeId}…`);
    try {
      const doc = await host.focusNode(nodeId);
      applyDocument(doc, `Focused ${nodeId}`);
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }

  async function clearFocus(): Promise<void> {
    if (!isFocused()) return;
    setStatus('Returning to overview…');
    try {
      const doc = await host.focusNode(null);
      applyDocument(doc, 'Overview');
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }

  async function clearSelection(): Promise<void> {
    if (!documentState?.view.selectedNodeId) return;
    try {
      const doc = await host.selectNode(null);
      applyDocument(doc);
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }

  function isCanvasChromeTarget(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    return Boolean(
      target.closest('.node') ||
        target.closest('.focus-back-btn') ||
        target.closest('.edit-composer') ||
        target.closest('.zoom-controls') ||
        target.closest('.zoom-readout')
    );
  }

  function onViewportClick(event: MouseEvent): void {
    if (suppressCanvasClick) {
      suppressCanvasClick = false;
      return;
    }
    if (event.button !== 0) return;
    // Second click of a dblclick can bubble from a node that skipped stopPropagation.
    if (event.detail > 1) return;
    if (isFocused()) return;
    if (isCanvasChromeTarget(event.target)) return;

    void clearSelection();
  }

  async function setSemanticLevel(level: OverviewLevel): Promise<void> {
    if (semanticLevel === level) return;
    semanticLevel = level;
    syncZoomControls();
    if (documentState) {
      documentState = {
        ...documentState,
        view: { ...documentState.view, semanticZoomLevel: level },
      };
      render();
    }
    setStatus(`Zoom ${level}…`);
    try {
      const doc = await host.updateView({ semanticZoomLevel: level });
      applyDocument(doc, `Zoom ${level}`);
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }

  function syncZoomControls(): void {
    if (!zoomControlsEl) return;
    for (const button of zoomControlsEl.querySelectorAll<HTMLButtonElement>('[data-zoom-level]')) {
      const level = button.dataset.zoomLevel;
      button.classList.toggle('is-active', level === semanticLevel);
      button.setAttribute('aria-pressed', level === semanticLevel ? 'true' : 'false');
      button.disabled = false;
      button.setAttribute('aria-disabled', 'false');
    }
  }

  function syncBackButton(): void {
    backBtn.hidden = !isFocused();
  }

  function syncEditComposer(): void {
    if (!editComposer) return;
    editComposer.setVisible(isFocused());
    editComposer.setFocusedNodeId(focusedNodeId);
  }

  function syncViewportFocusClass(): void {
    viewportEl.classList.toggle(
      'is-focused',
      focusedNodeId !== null ||
        focusPhase === 'lifting' ||
        focusPhase === 'open' ||
        focusPhase === 'lowering'
    );
  }

  function onZoomControlClick(event: Event): void {
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-zoom-level]');
    if (!target?.dataset.zoomLevel) return;
    const raw = target.dataset.zoomLevel;
    if (raw !== 'macro' && raw !== 'meso') return;
    void setSemanticLevel(raw);
  }

  function onWheel(event: WheelEvent): void {
    event.preventDefault();
    markCameraMoving();

    // Cmd (macOS) / Ctrl (Windows, trackpad pinch) + scroll → zoom toward cursor
    if (event.metaKey || event.ctrlKey) {
      const rect = viewportEl.getBoundingClientRect();
      const cursorX = event.clientX - rect.left;
      const cursorY = event.clientY - rect.top;
      const worldX = (cursorX - panX) / zoom;
      const worldY = (cursorY - panY) / zoom;
      const direction = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
      const nextZoom = clamp(zoom * direction, MIN_ZOOM, MAX_ZOOM);
      panX = cursorX - worldX * nextZoom;
      panY = cursorY - worldY * nextZoom;
      zoom = nextZoom;
      commitOverviewCamera();
      renderTransformOnly();
      return;
    }

    // Shift + scroll → pan left/right (use deltaY when the browser remaps vertical wheel)
    if (event.shiftKey) {
      const delta = event.deltaX !== 0 ? event.deltaX : event.deltaY;
      panX -= delta;
      commitOverviewCamera();
      renderTransformOnly();
      return;
    }

    // Plain scroll → pan both axes
    panX -= event.deltaX;
    panY -= event.deltaY;
    commitOverviewCamera();
    renderTransformOnly();
  }

  function endPan(): void {
    if (!isPanning) return;
    const moved =
      Math.hypot(panX - panStartX, panY - panStartY) > 3;
    isPanning = false;
    panPointerId = null;
    viewportEl.classList.remove('is-panning');
    markCameraMoving();
    commitOverviewCamera();
    if (moved) suppressCanvasClick = true;
  }

  function setSpaceHeld(next: boolean): void {
    spaceHeld = next;
    viewportEl.classList.toggle('is-space-pan', next);
    if (!next) endPan();
  }

  function resetZoomTo100(): void {
    const rect = viewportEl.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const worldX = (cx - panX) / zoom;
    const worldY = (cy - panY) / zoom;
    zoom = 1;
    panX = cx - worldX;
    panY = cy - worldY;
    commitOverviewCamera();
    renderTransformOnly();
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.code === 'Escape' && isFocused() && !isTypingTarget(event.target)) {
      event.preventDefault();
      void clearFocus();
      return;
    }
    if (
      (event.metaKey || event.ctrlKey) &&
      (event.code === 'Digit0' || event.code === 'Numpad0') &&
      !isTypingTarget(event.target)
    ) {
      event.preventDefault();
      resetZoomTo100();
      return;
    }
    if (event.code !== 'Space' || event.repeat) return;
    if (isTypingTarget(event.target)) return;
    event.preventDefault();
    setSpaceHeld(true);
  }

  function onKeyUp(event: KeyboardEvent): void {
    if (event.code !== 'Space') return;
    if (isTypingTarget(event.target)) return;
    event.preventDefault();
    setSpaceHeld(false);
  }

  function onWindowBlur(): void {
    setSpaceHeld(false);
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;

    if (!spaceHeld) return;
    if (target.closest('.node')) return;

    isPanning = true;
    panPointerId = event.pointerId;
    panOriginX = event.clientX;
    panOriginY = event.clientY;
    panStartX = panX;
    panStartY = panY;
    markCameraMoving();
    viewportEl.classList.add('is-panning');
    viewportEl.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: PointerEvent): void {
    if (!isPanning || event.pointerId !== panPointerId) return;
    markCameraMoving();
    panX = panStartX + (event.clientX - panOriginX);
    panY = panStartY + (event.clientY - panOriginY);
    renderTransformOnly();
  }

  function onPointerUp(event: PointerEvent): void {
    if (event.pointerId !== panPointerId) return;
    endPan();
  }

  function onBackClick(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    void clearFocus();
  }

  function onScrimClick(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
  }

  function onViewportResize(): void {
    if (focusPhase === 'idle' || !focusedNodeId) return;
    layoutFocusStates();
  }

  function renderTransformOnly(): void {
    const transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
    worldEl.style.transform = transform;
    edgesEl.style.transform = transform;
    edgesEl.style.transformOrigin = '0 0';
    focusFrontEl.style.transform = transform;
    focusFrontEl.style.transformOrigin = '0 0';
    // Single-layer LOD: hold ~24px screen density via power-of-two world step.
    const screenSpacing = adaptiveDotScreenSpacing(zoom);
    dotsEl.style.backgroundSize = `${screenSpacing}px ${screenSpacing}px`;
    dotsEl.style.backgroundPosition = `${panX}px ${panY}px`;
    syncChromeLabels();
    syncZoomReadout();
    if (semanticLevel === 'meso') scheduleMesoSnapshots();
  }

  /**
   * Titles live in screen space above each card — fixed scale, left-aligned, width = title.
   * Overview (meso): screen title + states pill on the right when the screen has fixtures.
   * Focus variants: variation name only (no states pill).
   */
  function syncChromeLabels(): void {
    const vp = viewportEl.getBoundingClientRect();
    const seen = new Set<string>();
    const statesSeen = new Set<string>();
    const labelGapPx = 6;
    const labelHeightPx = 22;
    const statesGapPx = 8;
    const overviewIdle = focusPhase === 'idle' && !isFocused();

    for (const [id, handle] of nodeHandles) {
      if (!handle.root.isConnected) continue;
      if (handle.root.classList.contains('is-fixture-hidden')) continue;
      if (handle.root.classList.contains('is-state-leave')) continue;

      const raised = handle.root.classList.contains('is-focus-raised');
      const inOverviewMount =
        handle.root.classList.contains('has-mount') && !raised && overviewIdle;

      if (!raised && !inOverviewMount) continue;

      const text = handle.root.dataset.chromeLabel?.trim();
      if (!text) continue;

      const rect = handle.root.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) continue;

      let label = chromeLayerEl.querySelector<HTMLElement>(`[data-chrome-node="${CSS.escape(id)}"]`);
      if (!label) {
        label = document.createElement('div');
        label.className = 'node-chrome-label';
        label.dataset.chromeNode = id;
        const span = document.createElement('span');
        label.append(span);
        chromeLayerEl.append(label);
      }

      const textEl = label.firstElementChild as HTMLElement;
      textEl.textContent = text;
      // Integer pixels avoid subpixel text blur on the overlay.
      const top = Math.round(rect.top - vp.top - labelGapPx - labelHeightPx);
      label.style.left = `${Math.round(rect.left - vp.left)}px`;
      label.style.top = `${top}px`;
      label.style.height = `${labelHeightPx}px`;
      label.style.removeProperty('width');
      seen.add(id);

      if (!inOverviewMount) continue;

      const fixtureCount = fixturesForScreen(id).length;
      if (fixtureCount === 0) continue;

      const count = 1 + fixtureCount;
      let statesPill = chromeLayerEl.querySelector<HTMLElement>(
        `[data-chrome-states="${CSS.escape(id)}"]`
      );
      if (!statesPill) {
        statesPill = document.createElement('div');
        statesPill.className = 'node-chrome-states';
        statesPill.dataset.chromeStates = id;
        chromeLayerEl.append(statesPill);
      }

      statesPill.textContent = `${count} states`;
      statesPill.style.top = `${top}px`;
      statesPill.style.height = `${labelHeightPx}px`;
      const pillWidth = Math.ceil(statesPill.getBoundingClientRect().width) || 64;
      let pillLeft = Math.round(rect.right - vp.left - pillWidth);
      const titleRight = label.getBoundingClientRect().right - vp.left;
      if (titleRight + statesGapPx > pillLeft) {
        pillLeft = Math.round(titleRight + statesGapPx);
      }
      statesPill.style.left = `${pillLeft}px`;
      statesSeen.add(id);
    }

    for (const label of [...chromeLayerEl.querySelectorAll<HTMLElement>('.node-chrome-label')]) {
      const id = label.dataset.chromeNode;
      if (!id || !seen.has(id)) label.remove();
    }

    for (const pill of [...chromeLayerEl.querySelectorAll<HTMLElement>('.node-chrome-states')]) {
      const id = pill.dataset.chromeStates;
      if (!id || !statesSeen.has(id)) pill.remove();
    }
  }

  function commitOverviewCamera(): void {
    if (focusPhase !== 'idle') return;
    overviewPanX = panX;
    overviewPanY = panY;
    overviewZoom = zoom;
    scheduleViewPersist();
  }

  function scheduleViewPersist(): void {
    if (suppressViewPersist || focusPhase !== 'idle') return;
    if (viewPersistTimer !== null) window.clearTimeout(viewPersistTimer);
    viewPersistTimer = window.setTimeout(() => {
      viewPersistTimer = null;
      void persistView();
    }, VIEW_DEBOUNCE_MS);
  }

  async function persistView(): Promise<void> {
    if (focusPhase !== 'idle') return;
    try {
      const doc = await host.updateView({
        pan: { x: panX, y: panY },
        zoom,
      });
      documentState = doc;
      overviewPanX = doc.view.pan.x;
      overviewPanY = doc.view.pan.y;
      overviewZoom = doc.view.zoom;
      setStatus(`View saved · ${doc.nodes.length} nodes · ${doc.view.semanticZoomLevel}`);
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }

  viewportEl.addEventListener('wheel', onWheel, { passive: false });
  viewportEl.addEventListener('pointerdown', onPointerDown);
  viewportEl.addEventListener('pointermove', onPointerMove);
  viewportEl.addEventListener('pointerup', onPointerUp);
  viewportEl.addEventListener('pointercancel', onPointerUp);
  viewportEl.addEventListener('click', onViewportClick);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onWindowBlur);
  window.addEventListener('resize', onViewportResize);
  colorSchemeQuery.addEventListener('change', onColorSchemeChange);
  zoomControlsEl?.addEventListener('click', onZoomControlClick);
  backBtn.addEventListener('click', onBackClick);
  scrimEl.addEventListener('click', onScrimClick);
  syncZoomControls();
  syncBackButton();
  syncEditComposer();
  syncZoomReadout();
  setFocusProgress(0);

  const unsubscribeLive = host.onDocument?.((doc) => {
    if (draggingNodeId) return;
    if (!acceptLiveUpdates) return;
    applyDocument(doc, 'Live update');
  });

  function destroy(): void {
    if (sdcGlobal.__sdcTeardown === destroy) {
      sdcGlobal.__sdcTeardown = undefined;
    }
    unsubscribeLive?.();
    editComposer?.destroy();
    snapshotGeneration += 1;
    snapshotQueue = [];
    snapshotCache.clear();
    snapshotErrors.clear();
    if (viewPersistTimer !== null) window.clearTimeout(viewPersistTimer);
    if (cameraIdleTimer !== null) window.clearTimeout(cameraIdleTimer);
    cancelFocusAnimation();
    focusWaitResolve = null;
    for (const handle of nodeHandles.values()) handle.destroy();
    nodeHandles.clear();
    viewportEl.classList.remove('is-space-pan', 'is-panning', 'is-focused', 'is-focus-instant');
    scrimEl.classList.remove('is-visible');
    setFocusProgress(0);
    setFocusPhase('idle');
    viewportEl.removeEventListener('wheel', onWheel);
    viewportEl.removeEventListener('pointerdown', onPointerDown);
    viewportEl.removeEventListener('pointermove', onPointerMove);
    viewportEl.removeEventListener('pointerup', onPointerUp);
    viewportEl.removeEventListener('pointercancel', onPointerUp);
    viewportEl.removeEventListener('click', onViewportClick);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onWindowBlur);
    window.removeEventListener('resize', onViewportResize);
    colorSchemeQuery.removeEventListener('change', onColorSchemeChange);
    zoomControlsEl?.removeEventListener('click', onZoomControlClick);
    backBtn.removeEventListener('click', onBackClick);
    scrimEl.removeEventListener('click', onScrimClick);
    backBtn.remove();
    zoomReadoutEl.remove();
    scrimEl.remove();
    focusFrontEl.remove();
  }

  sdcGlobal.__sdcTeardown = destroy;
  return { applyDocument, destroy };
}

/** World spacing snapped to a power-of-two of BASE so screen gap stays in band. */
function adaptiveDotScreenSpacing(zoom: number): number {
  const safeZoom = Math.max(zoom, MIN_ZOOM);
  let world = DOT_GRID_BASE;
  while (world * safeZoom < DOT_GRID_MIN_SCREEN) world *= 2;
  while (world * safeZoom > DOT_GRID_MAX_SCREEN) world /= 2;
  return world * safeZoom;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target.isContentEditable
  );
}

function coerceOverviewLevel(level: SemanticZoomLevel): OverviewLevel {
  return level === 'macro' ? 'macro' : 'meso';
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function ensureDotsLayer(viewportEl: HTMLElement): HTMLElement {
  const existing = viewportEl.querySelector<HTMLElement>('.canvas-dots');
  if (existing) return existing;

  const dots = document.createElement('div');
  dots.className = 'canvas-dots';
  dots.setAttribute('aria-hidden', 'true');
  viewportEl.insertBefore(dots, viewportEl.firstChild);
  return dots;
}

function ensureChromeLayer(viewportEl: HTMLElement): HTMLElement {
  const existing = viewportEl.querySelector<HTMLElement>('.node-chrome-layer');
  if (existing) return existing;

  const layer = document.createElement('div');
  layer.className = 'node-chrome-layer';
  layer.setAttribute('aria-hidden', 'true');
  viewportEl.appendChild(layer);
  return layer;
}

function ensureFocusScrim(viewportEl: HTMLElement): HTMLElement {
  const existing = viewportEl.querySelector<HTMLElement>('.focus-scrim');
  if (existing) return existing;

  const scrim = document.createElement('div');
  scrim.className = 'focus-scrim';
  scrim.setAttribute('aria-hidden', 'true');
  viewportEl.appendChild(scrim);
  return scrim;
}

function ensureFocusFront(viewportEl: HTMLElement): HTMLElement {
  const existing = viewportEl.querySelector<HTMLElement>('.focus-front');
  if (existing) return existing;

  const front = document.createElement('div');
  front.className = 'focus-front';
  viewportEl.appendChild(front);
  return front;
}

function ensureBackButton(viewportEl: HTMLElement): HTMLButtonElement {
  const existing = viewportEl.querySelector<HTMLButtonElement>('.focus-back-btn');
  if (existing) return existing;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'focus-back-btn';
  button.textContent = '← Back to overview';
  button.hidden = true;
  viewportEl.appendChild(button);
  return button;
}

function ensureZoomReadout(viewportEl: HTMLElement): HTMLElement {
  const existing = viewportEl.querySelector<HTMLElement>('.zoom-readout');
  if (existing) return existing;

  const readout = document.createElement('div');
  readout.className = 'zoom-readout';
  readout.setAttribute('aria-live', 'polite');
  readout.textContent = '100%';
  viewportEl.appendChild(readout);
  return readout;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function escapeXml(value: string): string {
  return escapeHtml(value);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
