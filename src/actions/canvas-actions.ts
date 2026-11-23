import { mapRunningApp } from '../preview/runtime-mapper.js';
import { resolveAppOrigin } from '../preview/preview-url.js';
import type { CanvasNode, CanvasViewState, DesignCanvasDocument } from '../types/domain.js';
import {
  CanvasStore,
  type ApplyRuntimeMapResult,
  type MapMode,
} from '../store/canvas-store.js';

export type DocumentListener = (document: DesignCanvasDocument) => void;

export interface AddScreenNodeInput {
  id: string;
  title: string;
  route: string;
  mfe: string;
  x: number;
  y: number;
  dataScreen?: string;
}

export interface AddFixtureNodeInput {
  id: string;
  parentId: string;
  title: string;
  fixture: string;
  previewPath: string;
  mfe?: string;
  x?: number;
  y?: number;
}

export interface AddModuleNodeInput {
  id: string;
  title: string;
  route: string;
  mfe: string;
  x: number;
  y: number;
  previewPath?: string;
  dataScreen?: string;
  frame?: { width: number; height: number };
  parentId?: string;
}

/**
 * Shared mutation facade for MCP tools and the HTTP agent API.
 * Emits after every successful write so same-process subscribers (SSE) update.
 * Cross-process hosts (Cursor MCP stdio vs web server) still sync via file watch.
 */
export class CanvasActions {
  readonly store: CanvasStore;
  private readonly listeners = new Set<DocumentListener>();

  constructor(store = new CanvasStore()) {
    this.store = store;
  }

  subscribe(listener: DocumentListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async read(): Promise<DesignCanvasDocument> {
    return this.store.read();
  }

  async list(): Promise<DesignCanvasDocument> {
    return this.read();
  }

  async addScreenNode(input: AddScreenNodeInput): Promise<DesignCanvasDocument> {
    const document = await this.store.addScreenNode({
      id: input.id,
      title: input.title,
      route: input.route,
      mfe: input.mfe,
      position: { x: input.x, y: input.y },
      ...(input.dataScreen !== undefined ? { dataScreen: input.dataScreen } : {}),
    });
    this.emit(document);
    return document;
  }

  async addFixtureNode(input: AddFixtureNodeInput): Promise<DesignCanvasDocument> {
    const document = await this.store.addFixtureNode({
      id: input.id,
      parentId: input.parentId,
      title: input.title,
      fixture: input.fixture,
      previewPath: input.previewPath,
      ...(input.mfe !== undefined ? { mfe: input.mfe } : {}),
      ...(input.x !== undefined && input.y !== undefined
        ? { position: { x: input.x, y: input.y } }
        : {}),
    });
    this.emit(document);
    return document;
  }

  async addModuleNode(input: AddModuleNodeInput): Promise<DesignCanvasDocument> {
    const document = await this.store.addModuleNode({
      id: input.id,
      title: input.title,
      route: input.route,
      mfe: input.mfe,
      position: { x: input.x, y: input.y },
      ...(input.previewPath !== undefined ? { previewPath: input.previewPath } : {}),
      ...(input.dataScreen !== undefined ? { dataScreen: input.dataScreen } : {}),
      ...(input.frame !== undefined ? { frame: input.frame } : {}),
      ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
    });
    this.emit(document);
    return document;
  }

  async selectNode(nodeId: string | null): Promise<DesignCanvasDocument> {
    const document = await this.store.selectNode(nodeId);
    this.emit(document);
    return document;
  }

  async moveNode(
    nodeId: string,
    position: { x: number; y: number }
  ): Promise<DesignCanvasDocument> {
    const document = await this.store.moveNode(nodeId, position);
    this.emit(document);
    return document;
  }

  async updateView(
    patch: Partial<
      Pick<
        CanvasViewState,
        'pan' | 'zoom' | 'selectedNodeId' | 'focusedNodeId' | 'semanticZoomLevel'
      >
    >
  ): Promise<DesignCanvasDocument> {
    const document = await this.store.updateView(patch);
    this.emit(document);
    return document;
  }

  /** Enter or exit the focused workspace. Unknown ids coerce to null (exit). */
  async focusNode(nodeId: string | null): Promise<DesignCanvasDocument> {
    const document = await this.store.focusNode(nodeId);
    this.emit(document);
    return document;
  }

  /**
   * Crawl DESIGN_CANVAS_APP_ORIGIN (or override) and upsert screens into the graph.
   */
  async mapApplication(options?: {
    mode?: MapMode;
    appOrigin?: string;
  }): Promise<ApplyRuntimeMapResult> {
    const appOrigin = resolveAppOrigin(options?.appOrigin);
    const crawl = await mapRunningApp({ appOrigin });
    const result = await this.store.applyRuntimeMap({
      mode: options?.mode ?? 'merge',
      screens: crawl.screens,
      edges: crawl.edges,
      chromeDestinations: crawl.chromeDestinations ?? [],
    });
    this.emit(result.document);
    return result;
  }

  /** Column layout by route depth for modules + screens. */
  async autoLayout(): Promise<DesignCanvasDocument> {
    const document = await this.store.applyAutoLayout();
    this.emit(document);
    return document;
  }

  private emit(document: DesignCanvasDocument): void {
    for (const listener of this.listeners) {
      try {
        listener(document);
      } catch (error) {
        console.error('[CanvasActions] listener failed:', error);
      }
    }
  }
}

export type { CanvasNode, DesignCanvasDocument, ApplyRuntimeMapResult, MapMode };
