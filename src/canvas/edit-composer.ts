import type { EditEvent } from './types';

export interface EditComposerHost {
  requestEdit(prompt: string, nodeId?: string): Promise<{ accepted: true; nodeId: string }>;
  resetEdit(): Promise<{ reset: true }>;
  cancelEdit?(): Promise<{ cancelled: boolean }>;
  onEdit?(handler: (event: EditEvent) => void): () => void;
}

export interface EditComposerHandle {
  setVisible(visible: boolean): void;
  setFocusedNodeId(nodeId: string | null): void;
  destroy(): void;
}

/**
 * Focus-only edit composer. Posts to the canvas API; live iframe HMR is the result.
 */
export function mountEditComposer(
  viewportEl: HTMLElement,
  host: EditComposerHost
): EditComposerHandle {
  const root = ensureComposer(viewportEl);
  const textarea = root.querySelector<HTMLTextAreaElement>('.edit-composer-input')!;
  const sendBtn = root.querySelector<HTMLButtonElement>('[data-edit-action="send"]')!;
  const newBtn = root.querySelector<HTMLButtonElement>('[data-edit-action="new"]')!;
  const cancelBtn = root.querySelector<HTMLButtonElement>('[data-edit-action="cancel"]')!;
  const statusEl = root.querySelector<HTMLElement>('.edit-composer-status')!;

  let focusedNodeId: string | null = null;
  let busy = false;
  let unsubscribeEdit: (() => void) | null = null;

  if (host.onEdit) {
    unsubscribeEdit = host.onEdit((event) => {
      busy = event.status === 'running';
      syncBusy();
      if (event.status === 'running') {
        setStatus(`Editing ${event.nodeId}…`);
      } else if (event.status === 'finished') {
        setStatus(event.text ? snippet(event.text) : `Done · ${event.nodeId}`);
      } else if (event.status === 'cancelled') {
        setStatus('Cancelled');
      } else {
        setStatus(event.error ?? 'Edit failed');
      }
    });
  }

  const onSend = (): void => {
    void submit();
  };
  const onNew = (): void => {
    void reset();
  };
  const onCancel = (): void => {
    void cancel();
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      void submit();
    }
  };

  sendBtn.addEventListener('click', onSend);
  newBtn.addEventListener('click', onNew);
  cancelBtn.addEventListener('click', onCancel);
  textarea.addEventListener('keydown', onKeyDown);

  syncBusy();
  setStatus('Describe a change for the focused screen');

  return {
    setVisible(visible) {
      root.hidden = !visible;
      if (!visible) {
        busy = false;
        syncBusy();
      }
    },
    setFocusedNodeId(nodeId) {
      focusedNodeId = nodeId;
    },
    destroy() {
      sendBtn.removeEventListener('click', onSend);
      newBtn.removeEventListener('click', onNew);
      cancelBtn.removeEventListener('click', onCancel);
      textarea.removeEventListener('keydown', onKeyDown);
      unsubscribeEdit?.();
      root.remove();
    },
  };

  async function submit(): Promise<void> {
    const prompt = textarea.value.trim();
    if (!prompt || busy) return;
    if (!focusedNodeId) {
      setStatus('Focus a screen first');
      return;
    }
    busy = true;
    syncBusy();
    setStatus(`Sending… (${focusedNodeId})`);
    try {
      const result = await host.requestEdit(prompt, focusedNodeId);
      setStatus(`Running · ${result.nodeId}`);
      textarea.value = '';
    } catch (error) {
      busy = false;
      syncBusy();
      setStatus(error instanceof Error ? error.message : 'Edit failed');
    }
  }

  async function reset(): Promise<void> {
    try {
      await host.resetEdit();
      busy = false;
      syncBusy();
      setStatus('New agent ready');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Reset failed');
    }
  }

  async function cancel(): Promise<void> {
    if (!host.cancelEdit) return;
    try {
      await host.cancelEdit();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Cancel failed');
    }
  }

  function syncBusy(): void {
    sendBtn.disabled = busy;
    cancelBtn.hidden = !busy;
    cancelBtn.disabled = !busy;
    textarea.disabled = busy;
    root.dataset.busy = busy ? 'true' : 'false';
  }

  function setStatus(message: string): void {
    statusEl.textContent = message;
  }
}

function ensureComposer(viewportEl: HTMLElement): HTMLElement {
  const existing = viewportEl.querySelector<HTMLElement>('.edit-composer');
  if (existing) return existing;

  const root = document.createElement('div');
  root.className = 'edit-composer';
  root.hidden = true;
  root.innerHTML = `
    <label class="edit-composer-label" for="edit-composer-input">Edit focused screen</label>
    <textarea
      id="edit-composer-input"
      class="edit-composer-input"
      rows="2"
      placeholder="What should change? (⌘/Ctrl+Enter to send)"
    ></textarea>
    <div class="edit-composer-actions">
      <p class="edit-composer-status" aria-live="polite"></p>
      <div class="edit-composer-buttons">
        <button type="button" class="edit-composer-btn" data-edit-action="cancel" hidden>Cancel</button>
        <button type="button" class="edit-composer-btn" data-edit-action="new">New</button>
        <button type="button" class="edit-composer-btn edit-composer-btn-primary" data-edit-action="send">Send</button>
      </div>
    </div>
  `;
  viewportEl.appendChild(root);
  return root;
}

function snippet(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1)}…`;
}
