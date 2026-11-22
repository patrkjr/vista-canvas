import {
  isDesignCanvasDocument,
  type CanvasHost,
  type CanvasHostConfig,
  type CanvasPoint,
  type DesignCanvasDocument,
  type EditEvent,
  type SemanticZoomLevel,
  type SnapshotRequest,
} from './types';

interface SharedEventSource {
  source: EventSource;
  documentHandlers: Set<(document: DesignCanvasDocument) => void>;
  editHandlers: Set<(event: EditEvent) => void>;
}

function isEditEvent(value: unknown): value is EditEvent {
  if (typeof value !== 'object' || value === null) return false;
  const event = value as Partial<EditEvent>;
  return (
    typeof event.nodeId === 'string' &&
    (event.status === 'running' ||
      event.status === 'finished' ||
      event.status === 'error' ||
      event.status === 'cancelled')
  );
}

export function createWebHost(apiBase = ''): CanvasHost {
  const base = apiBase.replace(/\/$/, '');
  const g = globalThis as typeof globalThis & { __sdcEvents?: SharedEventSource };

  async function request(
    path: string,
    init?: RequestInit
  ): Promise<DesignCanvasDocument> {
    const response = await fetch(`${base}${path}`, {
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
      ...init,
    });
    const payload: unknown = await response.json();
    if (!response.ok) {
      const message =
        typeof payload === 'object' &&
        payload !== null &&
        'error' in payload &&
        typeof (payload as { error: unknown }).error === 'string'
          ? (payload as { error: string }).error
          : `HTTP ${response.status}`;
      throw new Error(message);
    }
    if (!isDesignCanvasDocument(payload)) {
      throw new Error(`Unexpected response from ${path}`);
    }
    return payload;
  }

  async function requestJson<T>(
    path: string,
    init?: RequestInit,
    okStatuses: number[] = [200]
  ): Promise<T> {
    const response = await fetch(`${base}${path}`, {
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
      ...init,
    });
    const payload: unknown = await response.json();
    if (!okStatuses.includes(response.status)) {
      const message =
        typeof payload === 'object' &&
        payload !== null &&
        'error' in payload &&
        typeof (payload as { error: unknown }).error === 'string'
          ? (payload as { error: string }).error
          : `HTTP ${response.status}`;
      throw new Error(message);
    }
    return payload as T;
  }

  function ensureEvents(): SharedEventSource {
    const existing = g.__sdcEvents;
    if (existing && existing.source.readyState !== EventSource.CLOSED) {
      return existing;
    }
    existing?.source.close();

    const shared: SharedEventSource = {
      source: new EventSource(`${base}/api/events`),
      documentHandlers: new Set(),
      editHandlers: new Set(),
    };

    shared.source.addEventListener('document', ((event: MessageEvent<string>) => {
      try {
        const parsed: unknown = JSON.parse(event.data);
        if (!isDesignCanvasDocument(parsed)) return;
        for (const handler of shared.documentHandlers) handler(parsed);
      } catch {
        // ignore malformed SSE payloads
      }
    }) as EventListener);

    shared.source.addEventListener('edit', ((event: MessageEvent<string>) => {
      try {
        const parsed: unknown = JSON.parse(event.data);
        if (!isEditEvent(parsed)) return;
        for (const handler of shared.editHandlers) handler(parsed);
      } catch {
        // ignore malformed SSE payloads
      }
    }) as EventListener);

    shared.source.onerror = () => {
      // Browser will retry EventSource automatically.
    };

    g.__sdcEvents = shared;
    return shared;
  }

  return {
    loadDocument: () => request('/api/canvas'),

    async getConfig(): Promise<CanvasHostConfig> {
      const response = await fetch(`${base}/api/config`);
      const payload: unknown = await response.json();
      if (
        !response.ok ||
        typeof payload !== 'object' ||
        payload === null ||
        typeof (payload as { appOrigin?: unknown }).appOrigin !== 'string'
      ) {
        return { appOrigin: 'http://localhost:4200' };
      }
      return { appOrigin: (payload as { appOrigin: string }).appOrigin };
    },

    selectNode: (nodeId) =>
      request('/api/select', {
        method: 'POST',
        body: JSON.stringify({ nodeId }),
      }),

    focusNode: (nodeId) =>
      request('/api/focus', {
        method: 'POST',
        body: JSON.stringify({ nodeId }),
      }),

    moveNode: (nodeId, position) =>
      request('/api/nodes/move', {
        method: 'POST',
        body: JSON.stringify({ nodeId, x: position.x, y: position.y }),
      }),

    updateView: (patch: {
      pan?: CanvasPoint;
      zoom?: number;
      selectedNodeId?: string | null;
      focusedNodeId?: string | null;
      semanticZoomLevel?: SemanticZoomLevel;
    }) =>
      request('/api/view', {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),

    async getSnapshot(request: SnapshotRequest): Promise<Blob> {
      const params = new URLSearchParams({
        path: request.path,
        w: String(Math.round(request.width)),
        h: String(Math.round(request.height)),
        scheme: request.colorScheme,
      });
      const response = await fetch(`${base}/api/snapshots?${params}`);
      if (!response.ok) {
        let message = `HTTP ${response.status}`;
        try {
          const payload: unknown = await response.json();
          if (
            typeof payload === 'object' &&
            payload !== null &&
            'error' in payload &&
            typeof (payload as { error: unknown }).error === 'string'
          ) {
            message = (payload as { error: string }).error;
          }
        } catch {
          // keep status message
        }
        throw new Error(message);
      }
      return response.blob();
    },

    requestEdit: (prompt, nodeId) =>
      requestJson<{ accepted: true; nodeId: string }>(
        '/api/edit',
        {
          method: 'POST',
          body: JSON.stringify({
            prompt,
            ...(nodeId !== undefined ? { nodeId } : {}),
          }),
        },
        [202]
      ),

    resetEdit: () =>
      requestJson<{ reset: true }>('/api/edit/reset', {
        method: 'POST',
        body: '{}',
      }),

    cancelEdit: () =>
      requestJson<{ cancelled: boolean }>('/api/edit/cancel', {
        method: 'POST',
        body: '{}',
      }),

    onDocument(handler) {
      const shared = ensureEvents();
      shared.documentHandlers.add(handler);
      return () => {
        shared.documentHandlers.delete(handler);
        maybeCloseEvents(shared);
      };
    },

    onEdit(handler) {
      const shared = ensureEvents();
      shared.editHandlers.add(handler);
      return () => {
        shared.editHandlers.delete(handler);
        maybeCloseEvents(shared);
      };
    },
  };

  function maybeCloseEvents(shared: SharedEventSource): void {
    if (shared.documentHandlers.size > 0 || shared.editHandlers.size > 0) return;
    shared.source.close();
    if (g.__sdcEvents === shared) g.__sdcEvents = undefined;
  }
}
