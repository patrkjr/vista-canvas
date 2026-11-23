#!/usr/bin/env node
/**
 * Build a self-contained static demo:
 *   demo/export/index.html     — canvas (static host, no Node API)
 *   demo/export/mock-bank/     — packaged Nordhavn Bank
 *   demo/export/vercel.json    — SPA fallback for bank routes
 *
 * Prerequisites: mock-bank-mfe production build (npm run build there).
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const canvasRoot = path.resolve(__dirname, '..');
const exportRoot = path.join(canvasRoot, 'demo', 'export');
const seedDir = path.join(canvasRoot, 'demo', 'seed');
const bankRoot =
  process.env.MOCK_BANK_ROOT?.trim() ||
  process.env.DESIGN_CANVAS_TARGET?.trim() ||
  path.resolve(canvasRoot, '..', '..', 'angular', 'mock-bank-mfe');

function run(command, env = {}) {
  console.log(`[export-demo] $ ${command}`);
  execSync(command, {
    cwd: canvasRoot,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
}

fs.mkdirSync(seedDir, { recursive: true });
const seedSrc = path.join(bankRoot, '.design-canvas.json');
if (!fs.existsSync(seedSrc)) {
  throw new Error(`Missing canvas seed: ${seedSrc}`);
}
fs.copyFileSync(seedSrc, path.join(seedDir, 'design-canvas.json'));
console.log(`[export-demo] seed ← ${seedSrc}`);

run('node scripts/package-mock-bank.mjs', {
  DESIGN_CANVAS_TARGET: bankRoot,
  MOCK_BANK_ROOT: bankRoot,
});

run('npx cross-env CANVAS_BUILD_MODE=static vite build');

const builtHtml = path.join(exportRoot, 'export.html');
const indexHtml = path.join(exportRoot, 'index.html');
if (fs.existsSync(builtHtml)) {
  fs.renameSync(builtHtml, indexHtml);
}

const packagedBank = path.join(canvasRoot, 'demo', 'mock-bank');
const exportBank = path.join(exportRoot, 'mock-bank');
fs.rmSync(exportBank, { recursive: true, force: true });
fs.cpSync(packagedBank, exportBank, { recursive: true });

// Materialize SPA fallbacks as real files so deep previewPaths work even when
// host rewrites are unavailable (anonymous / static-file hosts).
const seed = JSON.parse(
  fs.readFileSync(path.join(seedDir, 'design-canvas.json'), 'utf8'),
);
const bankIndex = path.join(exportBank, 'index.html');
const previewPaths = new Set(['/']);
for (const node of seed.nodes ?? []) {
  const previewPath = typeof node.previewPath === 'string' ? node.previewPath : null;
  const route = typeof node.route === 'string' ? node.route : null;
  if (previewPath) previewPaths.add(previewPath.split('?')[0] ?? previewPath);
  if (route && !route.includes(':') && !route.startsWith('/__')) {
    previewPaths.add(route);
  }
}
for (const previewPath of previewPaths) {
  if (previewPath === '/' || previewPath === '') continue;
  const rel = previewPath.replace(/^\//, '').replace(/\/$/, '');
  if (!rel || rel.includes('..')) continue;
  const destDir = path.join(exportBank, rel);
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(bankIndex, path.join(destDir, 'index.html'));
}
console.log(
  `[export-demo] spa fallbacks × ${previewPaths.size - 1} under mock-bank/`,
);

fs.writeFileSync(
  path.join(exportRoot, 'vercel.json'),
  `${JSON.stringify(
    {
      // Bank shell uses <base href="/mock-bank/"> — keep the trailing slash.
      trailingSlash: true,
      rewrites: [
        // SPA fallback for unknown bank routes; real files win first.
        {
          source: '/mock-bank/:path*',
          destination: '/mock-bank/index.html',
        },
      ],
      headers: [
        {
          source: '/(.*)',
          headers: [{ key: 'X-Frame-Options', value: 'SAMEORIGIN' }],
        },
      ],
    },
    null,
    2,
  )}\n`,
);

console.log(`[export-demo] ready → ${exportRoot}`);
console.log('[export-demo] deploy: cd demo/export && npx vercel --yes --prod');
