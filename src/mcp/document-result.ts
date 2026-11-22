import type { CallToolResult } from '@modelcontextprotocol/server';

import type { DesignCanvasDocument } from '../types/domain.js';

export function documentToolResult(
  summary: string,
  document: DesignCanvasDocument
): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: `${summary}\n\n${JSON.stringify(document, null, 2)}`,
      },
    ],
    structuredContent: document as unknown as Record<string, unknown>,
  };
}

export function errorToolResult(message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
  };
}
