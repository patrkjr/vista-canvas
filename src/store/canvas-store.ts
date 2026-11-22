import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import type { CanvasEdge, CanvasNode, CanvasViewState, DesignCanvasDocument } from '../types/domain.js';
import { DesignCanvasDocumentSchema } from '../types/schema.js';
import { normalizeDocument } from './normalize.js';
import { createSeedDocument } from './seed.js';

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
        const seeded = createSeedDocument('mock-bank-mfe');
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
        const seeded = createSeedDocument('mock-bank-mfe');
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
