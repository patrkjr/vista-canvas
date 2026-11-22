import { createLogger, defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

const mode = process.env.CANVAS_BUILD_MODE ?? 'web';
const isMcpBundle = mode === 'mcp';
const isDevelopment = process.env.NODE_ENV === 'development';
const apiPort = Number(process.env.DESIGN_CANVAS_API_PORT ?? 4174);

const prefixedLogger = createLogger();
for (const level of ['info', 'warn', 'error'] as const) {
  const fn = prefixedLogger[level];
  prefixedLogger[level] = (msg, opts) => fn(msg.replace(/^/gm, '[vite] '), opts);
}

export default defineConfig({
  customLogger: prefixedLogger,
  plugins: isMcpBundle ? [viteSingleFile()] : [],
  server: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    sourcemap: isDevelopment ? 'inline' : undefined,
    cssMinify: !isDevelopment,
    minify: !isDevelopment,
    rollupOptions: {
      input: isMcpBundle ? 'design-canvas.html' : 'index.html',
    },
    outDir: 'dist',
    emptyOutDir: false,
  },
});
