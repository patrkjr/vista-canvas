import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import { createDesignCanvasServer } from './server.js';

async function main(): Promise<void> {
  const server = createDesignCanvasServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('[spatial-design-canvas] MCP server failed to start:', error);
  process.exit(1);
});
