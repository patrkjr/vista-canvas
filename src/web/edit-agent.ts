import { Agent, type Run, type SDKAgent } from '@cursor/sdk';

import type { CanvasNode } from '../types/domain.js';
import { resolveTargetRoot } from '../store/canvas-store.js';

export type EditRunStatus = 'running' | 'finished' | 'error' | 'cancelled';

export interface EditEvent {
  status: EditRunStatus;
  nodeId: string;
  text?: string;
  error?: string;
}

export type EditEventListener = (event: EditEvent) => void;

export interface EditRequest {
  prompt: string;
  node: CanvasNode;
}

export interface EditAgentOptions {
  targetRoot?: string;
  apiKey?: string;
  modelId?: string;
}

/**
 * Durable local Cursor SDK agent for canvas → agent edits.
 * Follow-ups reuse the same agent; reset() starts a fresh conversation.
 */
export class EditAgent {
  private readonly targetRoot: string;
  private readonly apiKey: string | undefined;
  private readonly modelId: string;
  private readonly listeners = new Set<EditEventListener>();
  private agent: SDKAgent | null = null;
  private activeRun: Run | null = null;

  constructor(options: EditAgentOptions = {}) {
    this.targetRoot = resolveTargetRoot(options.targetRoot);
    this.apiKey = (options.apiKey ?? process.env.CURSOR_API_KEY?.trim()) || undefined;
    this.modelId =
      options.modelId ??
      process.env.DESIGN_CANVAS_CURSOR_MODEL?.trim() ??
      'composer-2.5';
  }

  get configured(): boolean {
    return Boolean(this.apiKey);
  }

  get busy(): boolean {
    return this.activeRun !== null;
  }

  subscribe(listener: EditEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async send(request: EditRequest): Promise<{ accepted: true; nodeId: string }> {
    if (!this.apiKey) {
      throw new EditAgentError(
        'CURSOR_API_KEY is not set. Add it to .env for canvas edits.',
        503
      );
    }
    if (this.activeRun) {
      throw new EditAgentError('An edit is already running. Wait or cancel.', 409);
    }

    const prompt = buildEditPrompt(request.node, request.prompt);
    const agent = await this.ensureAgent();
    this.emit({ status: 'running', nodeId: request.node.id });

    try {
      const run = await agent.send(prompt);
      this.activeRun = run;
      void this.watchRun(run, request.node.id);
      return { accepted: true, nodeId: request.node.id };
    } catch (error) {
      this.activeRun = null;
      const message = errorMessage(error);
      this.emit({ status: 'error', nodeId: request.node.id, error: message });
      throw new EditAgentError(message, 500);
    }
  }

  async cancel(): Promise<{ cancelled: boolean }> {
    const run = this.activeRun;
    if (!run) return { cancelled: false };
    await run.cancel();
    return { cancelled: true };
  }

  async reset(): Promise<{ reset: true }> {
    if (this.activeRun) {
      try {
        await this.activeRun.cancel();
      } catch {
        // best-effort
      }
      this.activeRun = null;
    }
    if (this.agent) {
      this.agent.close();
      this.agent = null;
    }
    return { reset: true };
  }

  async close(): Promise<void> {
    await this.reset();
  }

  private async ensureAgent(): Promise<SDKAgent> {
    if (this.agent) return this.agent;
    if (!this.apiKey) {
      throw new EditAgentError('CURSOR_API_KEY is not set.', 503);
    }
    this.agent = await Agent.create({
      apiKey: this.apiKey,
      model: { id: this.modelId },
      local: { cwd: this.targetRoot },
      // Canvas MCP is agent→canvas only. Do not attach it to this edit agent.
      disallowedTools: ['mcp'],
    });
    return this.agent;
  }

  private async watchRun(run: Run, nodeId: string): Promise<void> {
    let snippet = '';
    try {
      for await (const event of run.stream()) {
        if (event.type === 'assistant') {
          for (const block of event.message.content) {
            if (block.type === 'text' && typeof block.text === 'string') {
              snippet = appendSnippet(snippet, block.text);
            }
          }
        }
      }
      const result = await run.wait();
      if (result.status === 'finished') {
        this.emit({
          status: 'finished',
          nodeId,
          ...(snippet ? { text: snippet } : {}),
        });
      } else if (result.status === 'cancelled') {
        this.emit({ status: 'cancelled', nodeId });
      } else {
        this.emit({
          status: 'error',
          nodeId,
          error: result.error?.message ?? 'Edit run failed',
          ...(snippet ? { text: snippet } : {}),
        });
      }
    } catch (error) {
      this.emit({
        status: 'error',
        nodeId,
        error: errorMessage(error),
        ...(snippet ? { text: snippet } : {}),
      });
    } finally {
      if (this.activeRun === run) this.activeRun = null;
    }
  }

  private emit(event: EditEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error('[EditAgent] listener failed:', error);
      }
    }
  }
}

export class EditAgentError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'EditAgentError';
    this.status = status;
  }
}

export function buildEditPrompt(node: CanvasNode, userPrompt: string): string {
  const preview = node.previewPath ?? node.route;
  const lines = [
    'You are editing the target app for a spatial design canvas.',
    'Work only in this repository (the bank / product app). Do not modify any spatial-design-canvas tooling.',
    'Prefer minimal, focused UI/code changes that match the request. Use the app’s existing patterns and theme tokens.',
    '',
    'Focused canvas node:',
    `- id: ${node.id}`,
    `- kind: ${node.kind}`,
    `- title: ${node.title}`,
    `- mfe: ${node.mfe}`,
    `- route: ${node.route}`,
    `- previewPath: ${preview}`,
    ...(node.fixture ? [`- fixture: ${node.fixture}`] : []),
    ...(node.parentId ? [`- parentId: ${node.parentId}`] : []),
    '',
    'User request:',
    userPrompt.trim(),
  ];
  return lines.join('\n');
}

function appendSnippet(current: string, next: string, max = 400): string {
  const combined = `${current}${next}`;
  if (combined.length <= max) return combined;
  return combined.slice(combined.length - max);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
