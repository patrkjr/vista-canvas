import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { pathMatchesPattern } from '../preview/path-patterns.js';
import type { DiscoveredEdge, DiscoveredScreen } from '../preview/runtime-mapper.js';
import type { CanvasEdge, CanvasNode, CanvasViewState, DesignCanvasDocument } from '../types/domain.js';
import { DesignCanvasDocumentSchema } from '../types/schema.js';
import { computeAutoLayout, computeFitView } from './auto-layout.js';
import { normalizeDocument } from './normalize.js';
import { createSeedDocument } from './seed.js';

const NAV_HUB_HINT = /nav|shell|menu|sidebar|rail/i;

export type MapMode = 'merge' | 'replace';

export interface ApplyRuntimeMapInput {
  readonly mode?: MapMode;
  readonly screens: readonly DiscoveredScreen[];
  /** In-product flow edges between screens. */
  readonly edges: readonly DiscoveredEdge[];
  /**
   * Discovered screen ids that are shared chrome/menu destinations.
   * Attached as `nav` edges from a module hub (created if missing).
   */
  readonly chromeDestinations?: readonly string[];
}

export interface ApplyRuntimeMapResult {
  readonly document: DesignCanvasDocument;
  readonly discovered: number;
  readonly added: number;
  readonly updated: number;
}

const DOCUMENT_FILENAME = '.design-canvas.json';

export function resolveTargetRoot(explicit?: string): string {
  const fromEnv = process.env.DESIGN_CANVAS_TARGET?.trim();
  const root = explicit?.trim() || fromEnv;
  if (!root) {
    throw new Error(
      'DESIGN_CANVAS_TARGET is not set. Point it at the mock-bank-mfe repository root.'
    );
  }
  return path.resolve(root);
}

export function documentPathFor(targetRoot: string): string {
  return path.join(targetRoot, DOCUMENT_FILENAME);
}

export class CanvasStore {
  readonly targetRoot: string;
  readonly documentPath: string;
  /** Serialize read-modify-write so concurrent tools don't clobber the file. */
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(targetRoot = resolveTargetRoot()) {
    this.targetRoot = targetRoot;
    this.documentPath = documentPathFor(targetRoot);
  }

  async read(): Promise<DesignCanvasDocument> {
    try {
      const raw = await readFile(this.documentPath, 'utf8');
      return normalizeDocument(DesignCanvasDocumentSchema.parse(JSON.parse(raw)));
    } catch (error) {
      if (isNotFound(error)) {
        const seeded = createSeedDocument(path.basename(this.targetRoot));
        await this.write(seeded);
        return seeded;
      }
      throw error;
    }
  }

  async write(document: DesignCanvasDocument): Promise<DesignCanvasDocument> {
    return this.enqueue(async () => this.writeUnlocked(document));
  }

  async addScreenNode(
    input: Omit<CanvasNode, 'kind'> & { kind?: CanvasNode['kind'] }
  ): Promise<DesignCanvasDocument> {
    return this.enqueue(async () => {
      const document = await this.readUnlocked();
      if (document.nodes.some((node) => node.id === input.id)) {
        throw new Error(`Node already exists: ${input.id}`);
      }

      const node: CanvasNode = {
        id: input.id,
        kind: 'screen',
        title: input.title,
        route: input.route,
        mfe: input.mfe,
        position: input.position,
        ...(input.dataScreen !== undefined ? { dataScreen: input.dataScreen } : {}),
        ...(input.previewPath !== undefined ? { previewPath: input.previewPath } : {}),
      };

      return this.writeUnlocked({
        ...document,
        nodes: [...document.nodes, node],
      });
    });
  }

  async addFixtureNode(input: {
    id: string;
    parentId: string;
    title: string;
    fixture: string;
    previewPath: string;
    mfe?: string;
    position?: { x: number; y: number };
  }): Promise<DesignCanvasDocument> {
    return this.enqueue(async () => {
      const document = await this.readUnlocked();
      if (document.nodes.some((node) => node.id === input.id)) {
        throw new Error(`Node already exists: ${input.id}`);
      }

      const parent = document.nodes.find(
        (node) => node.id === input.parentId && node.kind === 'screen'
      );
      if (!parent) {
        throw new Error(`Unknown parent screen: ${input.parentId}`);
      }

      const node: CanvasNode = {
        id: input.id,
        kind: 'fixture',
        title: input.title,
        route: parent.route,
        mfe: input.mfe ?? parent.mfe,
        position: input.position ?? {
          x: parent.position.x,
          y: parent.position.y + 280,
        },
        parentId: parent.id,
        fixture: input.fixture,
        previewPath: input.previewPath,
        ...(parent.dataScreen !== undefined ? { dataScreen: parent.dataScreen } : {}),
      };

      return this.writeUnlocked({
        ...document,
        nodes: [...document.nodes, node],
      });
    });
  }

  async addModuleNode(input: {
    id: string;
    title: string;
    route: string;
    mfe: string;
    position: { x: number; y: number };
    previewPath?: string;
    dataScreen?: string;
    frame?: { width: number; height: number };
    parentId?: string;
  }): Promise<DesignCanvasDocument> {
    return this.enqueue(async () => {
      const document = await this.readUnlocked();
      if (document.nodes.some((node) => node.id === input.id)) {
        throw new Error(`Node already exists: ${input.id}`);
      }

      const node: CanvasNode = {
        id: input.id,
        kind: 'module',
        title: input.title,
        route: input.route,
        mfe: input.mfe,
        position: input.position,
        ...(input.previewPath !== undefined ? { previewPath: input.previewPath } : {}),
        ...(input.dataScreen !== undefined ? { dataScreen: input.dataScreen } : {}),
        ...(input.frame !== undefined ? { frame: input.frame } : {}),
        ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
      };

      return this.writeUnlocked({
        ...document,
        nodes: [...document.nodes, node],
      });
    });
  }

  async selectNode(nodeId: string | null): Promise<DesignCanvasDocument> {
    return this.enqueue(async () => {
      const document = await this.readUnlocked();
      if (nodeId !== null && !document.nodes.some((node) => node.id === nodeId)) {
        throw new Error(`Unknown node: ${nodeId}`);
      }

      return this.writeUnlocked({
        ...document,
        view: {
          ...document.view,
          selectedNodeId: nodeId,
        },
      });
    });
  }

  async moveNode(
    nodeId: string,
    position: { x: number; y: number }
  ): Promise<DesignCanvasDocument> {
    return this.enqueue(async () => {
      const document = await this.readUnlocked();
      const index = document.nodes.findIndex((node) => node.id === nodeId);
      if (index < 0) throw new Error(`Unknown node: ${nodeId}`);

      const nodes = document.nodes.slice();
      nodes[index] = {
        ...nodes[index]!,
        position: { x: position.x, y: position.y },
      };

      return this.writeUnlocked({
        ...document,
        nodes,
      });
    });
  }

  /** Column layout by flow depth — modules left, entry screens stacked, flow children right. */
  async applyAutoLayout(): Promise<DesignCanvasDocument> {
    return this.enqueue(async () => {
      const document = await this.readUnlocked();
      return this.writeUnlocked(withAutoLayout(document));
    });
  }

  async updateView(
    patch: Partial<
      Pick<
        CanvasViewState,
        'pan' | 'zoom' | 'selectedNodeId' | 'focusedNodeId' | 'semanticZoomLevel'
      >
    >
  ): Promise<DesignCanvasDocument> {
    return this.enqueue(async () => {
      const document = await this.readUnlocked();
      const nextFocused =
        patch.focusedNodeId !== undefined ? patch.focusedNodeId : document.view.focusedNodeId;
      const focusedNodeId =
        nextFocused !== null && document.nodes.some((node) => node.id === nextFocused)
          ? nextFocused
          : null;

      // Entering focus also selects that node (same as focusNode).
      const selectedNodeId =
        patch.selectedNodeId !== undefined
          ? patch.selectedNodeId
          : patch.focusedNodeId !== undefined && focusedNodeId !== null
            ? focusedNodeId
            : document.view.selectedNodeId;

      return this.writeUnlocked({
        ...document,
        view: {
          ...document.view,
          ...patch,
          focusedNodeId,
          selectedNodeId,
        },
      });
    });
  }

  async focusNode(nodeId: string | null): Promise<DesignCanvasDocument> {
    return this.enqueue(async () => {
      const document = await this.readUnlocked();
      const focusedNodeId =
        nodeId !== null && document.nodes.some((node) => node.id === nodeId) ? nodeId : null;

      return this.writeUnlocked({
        ...document,
        view: {
          ...document.view,
          focusedNodeId,
          ...(focusedNodeId !== null ? { selectedNodeId: focusedNodeId } : {}),
        },
      });
    });
  }

  async addEdge(edge: CanvasEdge): Promise<DesignCanvasDocument> {
    return this.enqueue(async () => {
      const document = await this.readUnlocked();
      if (document.edges.some((existing) => existing.id === edge.id)) {
        throw new Error(`Edge already exists: ${edge.id}`);
      }
      return this.writeUnlocked({
        ...document,
        edges: [...document.edges, edge],
      });
    });
  }

  /**
   * Upsert screens discovered by a runtime crawl.
   * merge: keep modules/fixtures/unmatched screens + positions.
   * replace: drop previous screens and their edges; keep modules/fixtures.
   * Chrome destinations become `nav` edges from a module hub; crawl edges are flow only.
   */
  async applyRuntimeMap(input: ApplyRuntimeMapInput): Promise<ApplyRuntimeMapResult> {
    return this.enqueue(async () => {
      const document = await this.readUnlocked();
      const mode = input.mode ?? 'merge';
      const discovered = input.screens.length;

      let modules = document.nodes.filter((node) => node.kind === 'module');
      const fixtures = document.nodes.filter((node) => node.kind === 'fixture');
      const existingScreens = document.nodes.filter((node) => node.kind === 'screen');

      let added = 0;
      let updated = 0;
      const nextScreens: CanvasNode[] = mode === 'replace' ? [] : [...existingScreens];
      const keptIds = new Set(nextScreens.map((node) => node.id));
      /** Discovered crawl id → persisted node id */
      const discoveredToNodeId = new Map<string, string>();
      /** Prior screen id → surviving screen id (for fixture parent remaps). */
      const oldScreenToNew = new Map<string, string>();
      const canonicalIds = new Set<string>();

      for (const [index, screen] of input.screens.entries()) {
        // Match against the pre-crawl screen set so replace can reuse ids/positions.
        const existing = findMatchingScreen(
          mode === 'replace' ? existingScreens : nextScreens,
          screen
        );
        if (existing && mode === 'merge') {
          const idx = nextScreens.findIndex((node) => node.id === existing.id);
          if (idx >= 0) {
            nextScreens[idx] = {
              ...existing,
              title: screen.title || existing.title,
              route: screen.route,
              previewPath: screen.previewPath,
              mfe: screen.mfe !== 'unknown' ? screen.mfe : existing.mfe,
            };
            updated += 1;
          }
          discoveredToNodeId.set(screen.id, existing.id);
          oldScreenToNew.set(existing.id, existing.id);
          canonicalIds.add(existing.id);
          continue;
        }

        let id = existing ? existing.id : screen.id;
        if (keptIds.has(id) || nextScreens.some((node) => node.id === id)) {
          id = `${screen.id}-${index}`;
        }
        keptIds.add(id);
        discoveredToNodeId.set(screen.id, id);
        if (existing) oldScreenToNew.set(existing.id, id);
        canonicalIds.add(id);
        nextScreens.push({
          id,
          kind: 'screen',
          title: screen.title,
          route: screen.route,
          mfe: screen.mfe,
          position: existing?.position ?? { x: 0, y: 0 },
          previewPath: screen.previewPath,
        });
        added += 1;
      }

      // Drop leftover concrete siblings (e.g. /accounts/savings when we keep /accounts/:accountId).
      const prunedScreens =
        mode === 'replace'
          ? nextScreens
          : nextScreens.filter((node) => {
              if (canonicalIds.has(node.id)) return true;
              for (const screen of input.screens) {
                const nodePath = normalizePreviewPath(node.previewPath ?? node.route);
                if (screen.route.includes(':') && pathMatchesPattern(nodePath, screen.route)) {
                  return false;
                }
                if (isSiblingPath(nodePath, screen.previewPath)) return false;
              }
              return true;
            });

      const screenIds = new Set(prunedScreens.map((node) => node.id));

      // Also map old parents → new screens by route when ids changed under replace.
      for (const old of existingScreens) {
        if (oldScreenToNew.has(old.id)) continue;
        const match = findMatchingScreen(prunedScreens, {
          id: old.id,
          title: old.title,
          route: old.route,
          previewPath: old.previewPath ?? old.route,
          mfe: old.mfe,
          depth: 0,
        });
        if (match) oldScreenToNew.set(old.id, match.id);
      }

      // Remap fixture parents onto surviving screens; drop only true orphans.
      const nextFixtures = fixtures
        .map((fixture) => {
          if (!fixture.parentId) return null;
          const nextParentId =
            (screenIds.has(fixture.parentId) ? fixture.parentId : undefined) ??
            oldScreenToNew.get(fixture.parentId);
          if (!nextParentId || !screenIds.has(nextParentId)) return null;
          if (nextParentId === fixture.parentId) return fixture;
          return { ...fixture, parentId: nextParentId };
        })
        .filter((node): node is CanvasNode => node !== null);

      const chromeNodeIds = new Set(
        (input.chromeDestinations ?? [])
          .map((id) => discoveredToNodeId.get(id) ?? id)
          .filter((id) => screenIds.has(id))
      );

      const { hub, modules: nextModules } = resolveNavHub(modules, document.edges, input.screens);
      modules = nextModules;

      const nodeKindById = new Map<string, CanvasNode['kind']>();
      for (const node of document.nodes) nodeKindById.set(node.id, node.kind);
      for (const node of modules) nodeKindById.set(node.id, node.kind);
      for (const node of prunedScreens) nodeKindById.set(node.id, node.kind);

      // Keep non-chrome module edges that still point at surviving screens.
      // Hub→chrome nav edges are rebuilt below.
      const preservedEdges = document.edges.filter((edge) => {
        const fromKind = nodeKindById.get(edge.from);
        const toKind = nodeKindById.get(edge.to);
        if (fromKind === 'screen' && toKind === 'screen') return false;
        if (fromKind !== 'module' && toKind !== 'module') return false;
        if (toKind === 'screen' && !screenIds.has(edge.to)) return false;
        if (fromKind === 'screen' && !screenIds.has(edge.from)) return false;
        // Drop prior hub→chrome edges; they are re-emitted from classification.
        if (edge.from === hub.id && chromeNodeIds.has(edge.to) && edge.kind === 'nav') {
          return false;
        }
        return true;
      });

      const navEdges: CanvasEdge[] = [];
      for (const toId of chromeNodeIds) {
        const id = `edge-${hub.id}-to-${toId}`;
        if (
          preservedEdges.some((existing) => existing.id === id) ||
          navEdges.some((existing) => existing.id === id)
        ) {
          continue;
        }
        const target = prunedScreens.find((node) => node.id === toId);
        navEdges.push({
          id,
          from: hub.id,
          to: toId,
          kind: 'nav',
          ...(target?.title ? { label: target.title } : {}),
        });
      }

      const crawlEdges: CanvasEdge[] = [];
      for (const edge of input.edges) {
        const fromId = discoveredToNodeId.get(edge.from);
        const toId = discoveredToNodeId.get(edge.to);
        if (!fromId || !toId || fromId === toId) continue;
        // Chrome destinations are owned by the hub — never as screen↔screen edges.
        if (chromeNodeIds.has(toId)) continue;
        const id = `edge-${fromId}-to-${toId}`;
        if (
          preservedEdges.some((existing) => existing.id === id) ||
          navEdges.some((existing) => existing.id === id) ||
          crawlEdges.some((existing) => existing.id === id)
        ) {
          continue;
        }
        crawlEdges.push({
          id,
          from: fromId,
          to: toId,
          kind: 'flow',
          ...(edge.label !== undefined ? { label: edge.label } : {}),
        });
      }

      const edges = [...preservedEdges, ...navEdges, ...crawlEdges];
      const laidOut = withAutoLayout({
        ...document,
        nodes: [...modules, ...prunedScreens, ...nextFixtures],
        edges,
      });
      const nodeIds = new Set(laidOut.nodes.map((node) => node.id));
      const nextDocument = await this.writeUnlocked({
        ...laidOut,
        edges: laidOut.edges.filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to)),
      });

      return {
        document: nextDocument,
        discovered,
        added,
        updated,
      };
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(operation, operation);
    this.writeChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async readUnlocked(): Promise<DesignCanvasDocument> {
    try {
      const raw = await readFile(this.documentPath, 'utf8');
      return normalizeDocument(DesignCanvasDocumentSchema.parse(JSON.parse(raw)));
    } catch (error) {
      if (isNotFound(error)) {
        const seeded = createSeedDocument(path.basename(this.targetRoot));
        await this.writeUnlocked(seeded);
        return seeded;
      }
      throw error;
    }
  }

  private async writeUnlocked(document: DesignCanvasDocument): Promise<DesignCanvasDocument> {
    const normalized = normalizeDocument(DesignCanvasDocumentSchema.parse(document));
    await mkdir(path.dirname(this.documentPath), { recursive: true });
    const tempPath = `${this.documentPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    const payload = `${JSON.stringify(normalized, null, 2)}\n`;
    await writeFile(tempPath, payload, 'utf8');
    await rename(tempPath, this.documentPath);
    return normalized;
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  );
}

function withAutoLayout(document: DesignCanvasDocument): DesignCanvasDocument {
  const layout = computeAutoLayout(document.nodes, document.edges);
  const nodes = document.nodes.map((node) => {
    if (node.kind === 'fixture') return node;
    const position = layout.get(node.id);
    return position ? { ...node, position } : node;
  });
  return {
    ...document,
    nodes,
    view: computeFitView(nodes, layout, document.view),
  };
}

function normalizePreviewPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '/';
  const pathOnly = trimmed.split(/[?#]/)[0] ?? '/';
  if (!pathOnly || pathOnly === '/') return '/';
  const withSlash = pathOnly.startsWith('/') ? pathOnly : `/${pathOnly}`;
  const collapsed = withSlash.replace(/\/+/g, '/');
  return collapsed.length > 1 && collapsed.endsWith('/')
    ? collapsed.slice(0, -1)
    : collapsed;
}

function findMatchingScreen(
  screens: readonly CanvasNode[],
  discovered: DiscoveredScreen
): CanvasNode | undefined {
  const pathKey = normalizePreviewPath(discovered.previewPath);
  const exact = screens.find(
    (node) => normalizePreviewPath(node.previewPath ?? node.route) === pathKey
  );
  if (exact) return exact;

  if (discovered.route.includes(':')) {
    const byIncomingPattern = screens.find((node) =>
      pathMatchesPattern(normalizePreviewPath(node.previewPath ?? node.route), discovered.route)
    );
    if (byIncomingPattern) return byIncomingPattern;
  }

  return screens.find(
    (node) => node.route.includes(':') && pathMatchesPattern(pathKey, node.route)
  );
}

function isSiblingPath(left: string, right: string): boolean {
  const a = normalizePreviewPath(left).replace(/^\//, '').split('/').filter(Boolean);
  const b = normalizePreviewPath(right).replace(/^\//, '').split('/').filter(Boolean);
  // Top-level routes are distinct screens, not entity siblings.
  if (a.length < 2 || a.length !== b.length) return false;
  let diffs = 0;
  let shared = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] === b[i]) shared += 1;
    else diffs += 1;
    if (diffs > 1) return false;
  }
  return diffs === 1 && shared >= 1;
}

/**
 * Prefer an existing nav-like module; else the module with the most nav edges;
 * else the first module; else create `nav-hub`.
 */
export function resolveNavHub(
  modules: readonly CanvasNode[],
  edges: readonly CanvasEdge[],
  screens: readonly DiscoveredScreen[]
): { hub: CanvasNode; modules: CanvasNode[] } {
  if (modules.length > 0) {
    const byHint = modules.find((node) =>
      NAV_HUB_HINT.test(`${node.id} ${node.title} ${node.mfe} ${node.route}`)
    );
    if (byHint) return { hub: byHint, modules: [...modules] };

    let best: CanvasNode | undefined;
    let bestCount = -1;
    for (const module of modules) {
      const count = edges.filter(
        (edge) => edge.from === module.id && edge.kind === 'nav'
      ).length;
      if (count > bestCount) {
        best = module;
        bestCount = count;
      }
    }
    if (best) return { hub: best, modules: [...modules] };
    return { hub: modules[0]!, modules: [...modules] };
  }

  const remoteHint =
    screens.map((screen) => screen.mfe).find((mfe) => NAV_HUB_HINT.test(mfe)) ?? 'nav';
  const hub: CanvasNode = {
    id: 'nav-hub',
    kind: 'module',
    title: 'Nav',
    route: '/__canvas/module/nav',
    mfe: remoteHint,
    position: { x: 40, y: 80 },
    previewPath: '/__canvas/module/nav',
    dataScreen: 'nav-hub',
    frame: { width: 280, height: 800 },
  };
  return { hub, modules: [hub] };
}
