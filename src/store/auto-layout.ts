import type { CanvasEdge, CanvasNode, CanvasPoint, CanvasViewState } from '../types/domain.js';

/** Matches meso screen cards (420×262.5 from 1280×800). */
const COLUMN_SCREEN_WIDTH = 420;
const COLUMN_SCREEN_HEIGHT = (COLUMN_SCREEN_WIDTH * 800) / 1280;
const COLUMN_GAP = 160;
const ORIGIN_X = 40;
const ORIGIN_Y = 80;
const ROW_GAP = 56;
const LABEL_CLEARANCE = 40;

export interface AutoLayoutOptions {
  readonly originX?: number;
  readonly originY?: number;
  readonly columnGap?: number;
  readonly rowGap?: number;
}

/**
 * Place modules in the leftmost column, then screens in columns by **flow depth**
 * from entry/nav destinations (not raw URL segment count).
 *
 * - Column 0: screens reached via `nav` (or with no inbound `flow`) — peers stack downward
 * - Column 1+: screens one `flow` hop further — left → right by level
 * - Within a deeper column, prefer aligning to the parent's Y
 */
export function computeAutoLayout(
  nodes: readonly CanvasNode[],
  edges: readonly CanvasEdge[] = [],
  options: AutoLayoutOptions = {}
): Map<string, CanvasPoint> {
  const originX = options.originX ?? ORIGIN_X;
  const originY = options.originY ?? ORIGIN_Y;
  const columnGap = options.columnGap ?? COLUMN_GAP;
  const rowGap = options.rowGap ?? ROW_GAP;
  const strideY = (node: CanvasNode): number =>
    layoutSize(node).height + rowGap + LABEL_CLEARANCE;

  const modules = nodes.filter((node) => node.kind === 'module');
  const screens = nodes.filter((node) => node.kind === 'screen');
  const positions = new Map<string, CanvasPoint>();

  let cursorX = originX;

  if (modules.length > 0) {
    const moduleWidth = Math.max(
      ...modules.map((node) => layoutSize(node).width),
      160
    );
    let cursorY = originY;
    const orderedModules = sortModules(modules, edges, screens);
    for (const node of orderedModules) {
      positions.set(node.id, { x: cursorX, y: cursorY });
      cursorY += strideY(node);
    }
    cursorX += moduleWidth + columnGap;
  }

  if (screens.length === 0) return positions;

  const depths = computeScreenDepths(screens, edges);
  const byDepth = new Map<number, CanvasNode[]>();
  for (const screen of screens) {
    const depth = depths.get(screen.id) ?? 0;
    const list = byDepth.get(depth) ?? [];
    list.push(screen);
    byDepth.set(depth, list);
  }

  const depthKeys = [...byDepth.keys()].sort((a, b) => a - b);
  for (const depth of depthKeys) {
    const column = byDepth.get(depth) ?? [];
    const ordered =
      depth === 0
        ? sortEntryScreens(column, edges, modules)
        : sortScreensInColumn(column, edges, positions);

    const placedY = new Map<string, number>();
    let columnWidth = COLUMN_SCREEN_WIDTH;

    if (depth === 0) {
      let cursorY = originY;
      for (const node of ordered) {
        positions.set(node.id, { x: cursorX, y: cursorY });
        placedY.set(node.id, cursorY);
        columnWidth = Math.max(columnWidth, layoutSize(node).width);
        cursorY += strideY(node);
      }
    } else {
      // Prefer parent Y; resolve overlaps top→bottom.
      const tentative = ordered.map((node) => {
        const preferred = preferredY(node.id, edges, positions) ?? originY;
        return { node, preferred };
      });
      tentative.sort((a, b) => a.preferred - b.preferred || a.node.title.localeCompare(b.node.title));

      let nextFreeY = originY;
      for (const { node, preferred } of tentative) {
        const y = Math.max(preferred, nextFreeY);
        positions.set(node.id, { x: cursorX, y });
        placedY.set(node.id, y);
        columnWidth = Math.max(columnWidth, layoutSize(node).width);
        nextFreeY = y + strideY(node);
      }
    }

    cursorX += columnWidth + columnGap;
  }

  return positions;
}

/**
 * Entry screens (depth 0) = targets of `nav` edges, or screens with no inbound `flow`.
 * Deeper screens = min inbound-flow parent depth + 1.
 * Orphans / cycles fall back to route segment depth (shifted so `/` counts as 0 with peers).
 */
export function computeScreenDepths(
  screens: readonly CanvasNode[],
  edges: readonly CanvasEdge[]
): Map<string, number> {
  const screenIds = new Set(screens.map((node) => node.id));
  const depths = new Map<string, number>();
  const inboundFlow = new Map<string, string[]>();
  const navTargets = new Set<string>();

  for (const edge of edges) {
    if (!screenIds.has(edge.to)) continue;
    if (edge.kind === 'nav') {
      navTargets.add(edge.to);
      continue;
    }
    if (edge.kind !== 'flow') continue;
    if (!screenIds.has(edge.from)) continue;
    const list = inboundFlow.get(edge.to) ?? [];
    list.push(edge.from);
    inboundFlow.set(edge.to, list);
  }

  for (const screen of screens) {
    const hasInboundFlow = (inboundFlow.get(screen.id) ?? []).length > 0;
    if (navTargets.has(screen.id) || !hasInboundFlow) {
      depths.set(screen.id, 0);
    }
  }

  let changed = true;
  let guard = screens.length + 2;
  while (changed && guard > 0) {
    changed = false;
    guard -= 1;
    for (const screen of screens) {
      if (depths.has(screen.id)) continue;
      const parents = inboundFlow.get(screen.id) ?? [];
      const parentDepths = parents
        .map((id) => depths.get(id))
        .filter((value): value is number => value !== undefined);
      if (parentDepths.length === 0) continue;
      depths.set(screen.id, Math.min(...parentDepths) + 1);
      changed = true;
    }
  }

  for (const screen of screens) {
    if (!depths.has(screen.id)) {
      depths.set(screen.id, Math.max(0, routeDepth(screen.route)));
    }
  }

  return depths;
}

/** Route segment count: `/` → 0, `/transfer` → 1, `/accounts/:id` → 2. */
export function routeDepth(route: string): number {
  const path = route.trim().split(/[?#]/)[0] ?? '/';
  if (!path || path === '/') return 0;
  return path.replace(/^\//, '').split('/').filter(Boolean).length;
}

function layoutSize(node: CanvasNode): { width: number; height: number } {
  if (node.kind === 'module' && node.frame) {
    const max = 420;
    const scale = max / Math.max(node.frame.width, node.frame.height);
    return {
      width: Math.max(120, node.frame.width * scale),
      height: Math.max(160, node.frame.height * scale),
    };
  }
  return { width: COLUMN_SCREEN_WIDTH, height: COLUMN_SCREEN_HEIGHT };
}

function sortModules(
  modules: readonly CanvasNode[],
  edges: readonly CanvasEdge[],
  screens: readonly CanvasNode[]
): CanvasNode[] {
  const screenIds = new Set(screens.map((node) => node.id));
  const outbound = new Map<string, number>();
  for (const edge of edges) {
    if (!modules.some((module) => module.id === edge.from)) continue;
    if (!screenIds.has(edge.to)) continue;
    outbound.set(edge.from, (outbound.get(edge.from) ?? 0) + 1);
  }
  return [...modules].sort((a, b) => {
    const byEdges = (outbound.get(b.id) ?? 0) - (outbound.get(a.id) ?? 0);
    if (byEdges !== 0) return byEdges;
    return a.title.localeCompare(b.title);
  });
}

/** Entry column: follow hub nav edge order when present, else title/route. */
function sortEntryScreens(
  column: readonly CanvasNode[],
  edges: readonly CanvasEdge[],
  modules: readonly CanvasNode[]
): CanvasNode[] {
  const columnIds = new Set(column.map((node) => node.id));
  const order = new Map<string, number>();
  let index = 0;
  for (const module of modules) {
    for (const edge of edges) {
      if (edge.from !== module.id || edge.kind !== 'nav') continue;
      if (!columnIds.has(edge.to) || order.has(edge.to)) continue;
      order.set(edge.to, index);
      index += 1;
    }
  }

  return [...column].sort((a, b) => {
    const ao = order.get(a.id);
    const bo = order.get(b.id);
    if (ao !== undefined && bo !== undefined && ao !== bo) return ao - bo;
    if (ao !== undefined && bo === undefined) return -1;
    if (ao === undefined && bo !== undefined) return 1;
    return a.title.localeCompare(b.title) || a.route.localeCompare(b.route);
  });
}

function sortScreensInColumn(
  column: readonly CanvasNode[],
  edges: readonly CanvasEdge[],
  placed: ReadonlyMap<string, CanvasPoint>
): CanvasNode[] {
  const columnIds = new Set(column.map((node) => node.id));
  const parentY = new Map<string, number>();

  for (const edge of edges) {
    if (edge.kind === 'nav') continue;
    if (!columnIds.has(edge.to)) continue;
    const fromPos = placed.get(edge.from);
    if (!fromPos) continue;
    const prev = parentY.get(edge.to);
    if (prev === undefined || fromPos.y < prev) parentY.set(edge.to, fromPos.y);
  }

  return [...column].sort((a, b) => {
    const ay = parentY.get(a.id) ?? Number.POSITIVE_INFINITY;
    const by = parentY.get(b.id) ?? Number.POSITIVE_INFINITY;
    if (ay !== by) return ay - by;
    return a.title.localeCompare(b.title) || a.route.localeCompare(b.route);
  });
}

function preferredY(
  nodeId: string,
  edges: readonly CanvasEdge[],
  placed: ReadonlyMap<string, CanvasPoint>
): number | undefined {
  let best: number | undefined;
  for (const edge of edges) {
    if (edge.kind === 'nav') continue;
    if (edge.to !== nodeId) continue;
    const fromPos = placed.get(edge.from);
    if (!fromPos) continue;
    if (best === undefined || fromPos.y < best) best = fromPos.y;
  }
  return best;
}

/**
 * Camera that fits laid-out modules/screens into a typical overview viewport.
 * Keeps existing selection / semantic zoom.
 */
export function computeFitView(
  nodes: readonly CanvasNode[],
  positions: ReadonlyMap<string, CanvasPoint>,
  view: CanvasViewState,
  viewport: { width: number; height: number } = { width: 1280, height: 800 }
): CanvasViewState {
  const laidOut = nodes.filter(
    (node) => (node.kind === 'module' || node.kind === 'screen') && positions.has(node.id)
  );
  if (laidOut.length === 0) return view;

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const node of laidOut) {
    const pos = positions.get(node.id)!;
    const size = layoutSize(node);
    minX = Math.min(minX, pos.x);
    minY = Math.min(minY, pos.y - LABEL_CLEARANCE);
    maxX = Math.max(maxX, pos.x + size.width);
    maxY = Math.max(maxY, pos.y + size.height);
  }

  const pad = 64;
  const contentW = Math.max(1, maxX - minX + pad * 2);
  const contentH = Math.max(1, maxY - minY + pad * 2);
  const zoom = Math.min(
    1,
    viewport.width / contentW,
    viewport.height / contentH
  );
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  return {
    ...view,
    zoom,
    pan: {
      x: viewport.width / 2 - centerX * zoom,
      y: viewport.height / 2 - centerY * zoom,
    },
  };
}
