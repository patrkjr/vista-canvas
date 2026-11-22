import type { CanvasNodeFrame, SemanticZoomLevel, ViewportAdapterKind } from '../types/domain';

export type ViewportMountMode = 'still' | 'live';

export interface ViewportContext {
  readonly nodeId: string;
  readonly title: string;
  readonly previewUrl: string;
  readonly semanticZoomLevel: SemanticZoomLevel;
  /** When false, the mount should ignore pointer events (meso preview). */
  readonly interactive: boolean;
  /** Native iframe size. Defaults to WORKSPACE_SIZE. */
  readonly frame?: CanvasNodeFrame;
  /** Meso uses stills; focus uses a live iframe. Defaults to live. */
  readonly mode?: ViewportMountMode;
  /** Object URL (or data URL) for SnapshotAdapter. */
  readonly snapshotUrl?: string | null;
  /** Snapshot load failed — show the unavailable hint. */
  readonly snapshotError?: string | null;
}

export interface ViewportAdapter {
  readonly kind: ViewportAdapterKind;
  mount(host: HTMLElement, context: ViewportContext): void;
  unmount(): void;
}

export interface NodeBoxSize {
  readonly width: number;
  readonly height: number;
}

/** Focused workspace size — matches the desktop bank iframe (not a semantic zoom level). */
export const WORKSPACE_SIZE: NodeBoxSize = { width: 1280, height: 800 };

const MESO_MAX = 420;
/** Meso height matches scaled 1280×800 so the mount has no letterbox. */
const MESO_HEIGHT = (MESO_MAX * WORKSPACE_SIZE.height) / WORKSPACE_SIZE.width;

/** Overview node boxes. Legacy `micro` maps to meso sizing. */
export const NODE_SIZES: Record<SemanticZoomLevel, NodeBoxSize> = {
  macro: { width: 220, height: 148 },
  meso: { width: MESO_MAX, height: MESO_HEIGHT },
  micro: { width: MESO_MAX, height: MESO_HEIGHT },
};

/** Native iframe size for a node — screens default to 1280×800. */
export function nativeFrame(frame?: CanvasNodeFrame | null): NodeBoxSize {
  if (frame && frame.width > 0 && frame.height > 0) return frame;
  return WORKSPACE_SIZE;
}

/**
 * Meso box that fits `frame` without letterboxing a 1280×800 page.
 * Longer side maps to MESO_MAX (420) so a 280×800 rail becomes ~147×420.
 */
export function mesoBoxSize(frame?: CanvasNodeFrame | null): NodeBoxSize {
  const native = nativeFrame(frame);
  const scale = MESO_MAX / Math.max(native.width, native.height);
  return {
    width: native.width * scale,
    height: native.height * scale,
  };
}

export function overviewBoxSize(
  level: SemanticZoomLevel,
  frame?: CanvasNodeFrame | null
): NodeBoxSize {
  if (level === 'macro') return NODE_SIZES.macro;
  return mesoBoxSize(frame);
}
