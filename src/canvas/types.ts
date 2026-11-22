export interface CanvasPoint {
  x: number;
  y: number;
}

export interface CanvasNodeFrame {
  width: number;
  height: number;
}

export interface CanvasNode {
  id: string;
  kind: 'screen' | 'fixture' | 'module';
  title: string;
  route: string;
  mfe: string;
  position: CanvasPoint;
  dataScreen?: string;
  previewPath?: string;
  parentId?: string;
  fixture?: string;
  frame?: CanvasNodeFrame;
}

export interface CanvasEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
  kind?: 'flow' | 'nav';
}

export type SemanticZoomLevel = 'macro' | 'meso' | 'micro';

export interface CanvasViewState {
  pan: CanvasPoint;
  zoom: number;
  selectedNodeId: string | null;
  focusedNodeId: string | null;
  semanticZoomLevel: SemanticZoomLevel;
}

export interface DesignCanvasDocument {
  version: number;
  target: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  view: CanvasViewState;
}

export interface CanvasHostConfig {
  appOrigin: string;
}

export type SnapshotColorScheme = 'light' | 'dark';

export interface SnapshotRequest {
  path: string;
  width: number;
  height: number;
  colorScheme: SnapshotColorScheme;
}

export type EditRunStatus = 'running' | 'finished' | 'error' | 'cancelled';

export interface EditEvent {
  status: EditRunStatus;
  nodeId: string;
  text?: string;
  error?: string;
}

export interface CanvasHost {
  loadDocument(): Promise<DesignCanvasDocument>;
  getConfig(): Promise<CanvasHostConfig>;
  selectNode(nodeId: string | null): Promise<DesignCanvasDocument>;
  focusNode(nodeId: string | null): Promise<DesignCanvasDocument>;
  moveNode(nodeId: string, position: CanvasPoint): Promise<DesignCanvasDocument>;
  updateView(patch: {
    pan?: CanvasPoint;
    zoom?: number;
    selectedNodeId?: string | null;
    focusedNodeId?: string | null;
    semanticZoomLevel?: SemanticZoomLevel;
  }): Promise<DesignCanvasDocument>;
  /** Optional live updates (SSE / MCP tool results). */
  onDocument?(handler: (document: DesignCanvasDocument) => void): () => void;
  /** Optional meso stills (web host). MCP omits — meso shows skeletons only. */
  getSnapshot?(request: SnapshotRequest): Promise<Blob>;
  /** Canvas → agent edit (web host). MCP omits — no composer. */
  requestEdit?(prompt: string, nodeId?: string): Promise<{ accepted: true; nodeId: string }>;
  resetEdit?(): Promise<{ reset: true }>;
  cancelEdit?(): Promise<{ cancelled: boolean }>;
  onEdit?(handler: (event: EditEvent) => void): () => void;
}

export function isDesignCanvasDocument(value: unknown): value is DesignCanvasDocument {
  if (typeof value !== 'object' || value === null) return false;
  const doc = value as Partial<DesignCanvasDocument>;
  return (
    typeof doc.version === 'number' &&
    typeof doc.target === 'string' &&
    Array.isArray(doc.nodes) &&
    Array.isArray(doc.edges) &&
    typeof doc.view === 'object' &&
    doc.view !== null
  );
}
