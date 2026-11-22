import type { SnapshotColorScheme, SnapshotRequest } from './types';

export interface SnapshotCacheKey {
  readonly path: string;
  readonly width: number;
  readonly height: number;
  readonly colorScheme: SnapshotColorScheme;
}

interface SnapshotCacheEntry {
  readonly key: string;
  readonly objectUrl: string;
  readonly blob: Blob;
}

const DEFAULT_CAPACITY = 64;

/**
 * Client-side object-URL LRU for meso stills.
 * Fetching is owned by the renderer queue; this only stores blobs.
 */
export class SnapshotObjectCache {
  private readonly entries = new Map<string, SnapshotCacheEntry>();
  private readonly capacity: number;

  constructor(capacity = DEFAULT_CAPACITY) {
    this.capacity = capacity;
  }

  static keyOf(request: SnapshotCacheKey): string {
    return `${request.path}|${request.width}x${request.height}|${request.colorScheme}`;
  }

  get(request: SnapshotCacheKey): string | null {
    const key = SnapshotObjectCache.keyOf(request);
    const entry = this.entries.get(key);
    if (!entry) return null;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.objectUrl;
  }

  has(request: SnapshotCacheKey): boolean {
    return this.entries.has(SnapshotObjectCache.keyOf(request));
  }

  put(request: SnapshotCacheKey, blob: Blob): string {
    const key = SnapshotObjectCache.keyOf(request);
    const existing = this.entries.get(key);
    if (existing) {
      URL.revokeObjectURL(existing.objectUrl);
      this.entries.delete(key);
    }
    const objectUrl = URL.createObjectURL(blob);
    this.entries.set(key, { key, objectUrl, blob });
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      const doomed = this.entries.get(oldest);
      if (doomed) URL.revokeObjectURL(doomed.objectUrl);
      this.entries.delete(oldest);
    }
    return objectUrl;
  }

  clear(): void {
    for (const entry of this.entries.values()) {
      URL.revokeObjectURL(entry.objectUrl);
    }
    this.entries.clear();
  }
}

export function preferredColorScheme(): SnapshotColorScheme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function toSnapshotRequest(
  key: SnapshotCacheKey
): SnapshotRequest {
  return {
    path: key.path,
    width: key.width,
    height: key.height,
    colorScheme: key.colorScheme,
  };
}
