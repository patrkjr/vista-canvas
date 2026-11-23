import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createWebServer } from './http.js';

loadEnvFile();

async function main(): Promise<void> {
  const running = createWebServer();
  const url = `http://${running.host}:${running.port}`;
  console.log(`[vista-canvas] HTTP agent API listening on ${url}`);
  console.log(`  GET  ${url}/api/canvas`);
  console.log(`  GET  ${url}/api/config`);
  console.log(`  GET  ${url}/api/snapshots`);
  console.log(`  POST ${url}/api/snapshots/invalidate`);
  console.log(`  POST ${url}/api/map`);
  console.log(`  POST ${url}/api/layout`);
  console.log(`  POST ${url}/api/nodes`);
  console.log(`  POST ${url}/api/fixtures`);
  console.log(`  POST ${url}/api/modules`);
  console.log(`  POST ${url}/api/select`);
  console.log(`  POST ${url}/api/focus`);
  console.log(`  PATCH ${url}/api/view`);
  console.log(`  GET  ${url}/api/events  (SSE document)`);

  const shutdown = async (): Promise<void> => {
    console.log('\nShutting down web API…');
    await running.close();
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });
}

function loadEnvFile(): void {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const envPath = path.join(root, '.env');
  try {
    process.loadEnvFile(envPath);
  } catch (error) {
    // Missing .env is fine — env may come from the shell.
    if (isErrnoException(error) && error.code === 'ENOENT') return;
    console.warn('[vista-canvas] failed to load .env:', errorMessage(error));
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

main().catch((error) => {
  console.error('[vista-canvas] web server failed:', error);
  process.exit(1);
});
