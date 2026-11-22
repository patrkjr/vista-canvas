/**
 * Core domain vocabulary for the Spatial Live-Code Design Canvas.
 */

export type SemanticZoomLevel = 'macro' | 'meso' | 'micro';

export type CanvasRenderMode = 'structural' | 'styled';

export type ViewportAdapterKind = 'web-iframe' | 'native-stream' | 'snapshot';

export type CanvasNodeKind = 'screen' | 'fixture' | 'module';

export type CanvasEdgeKind = 'flow' | 'nav';

export interface CanvasNodeFrame {
  readonly width: number;
  readonly height: number;
}

export interface DesignCanvasMetadata {
  readonly name: string;
  readonly version: string;
  readonly currentSprint: number;
  readonly supportedZoomLevels: readonly SemanticZoomLevel[];
  readonly supportedRenderModes: readonly CanvasRenderMode[];
  readonly plannedAdapters: readonly ViewportAdapterKind[];
}

export interface CanvasPoint {
  readonly x: number;
  readonly y: number;
}

export interface CanvasNode {
  readonly id: string;
  readonly kind: CanvasNodeKind;
  readonly title: string;
  /** Route pattern as in the target app (may include :params). */
  readonly route: string;
  readonly mfe: string;
  readonly position: CanvasPoint;
  readonly dataScreen?: string;
  /** Concrete path for iframe mounts when `route` has params (e.g. /accounts/everyday). */
  readonly previewPath?: string;
  /** Parent screen id when `kind === 'fixture'`. */
  readonly parentId?: string;
  /** Edge-case state key when `kind === 'fixture'` (e.g. empty_transactions). */
  readonly fixture?: string;
  /** Native iframe size. Screens default to 1280×800; modules set their own (nav rail ~280×800). */
  readonly frame?: CanvasNodeFrame;
}

export interface CanvasEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly label?: string;
  /** Missing kind normalizes to `flow`. Nav edges are menu → destination. */
  readonly kind?: CanvasEdgeKind;
}

export interface CanvasViewState {
  readonly pan: CanvasPoint;
  readonly zoom: number;
  readonly selectedNodeId: string | null;
  /** Screen currently in the focused workspace; null = overview. */
  readonly focusedNodeId: string | null;
  readonly semanticZoomLevel: SemanticZoomLevel;
}

export interface DesignCanvasDocument {
  readonly version: number;
  readonly target: string;
  readonly nodes: readonly CanvasNode[];
  readonly edges: readonly CanvasEdge[];
  readonly view: CanvasViewState;
}
