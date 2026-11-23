#!/usr/bin/env node
/**
 * Copy a production mock-bank-mfe build into demo/mock-bank/ for single-origin hosting.
 *
 * Expects MOCK_BANK_ROOT (default: sibling ../mock-bank-mfe or DESIGN_CANVAS_TARGET)
 * to already contain `npm run build` output under dist/<app>/browser.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const canvasRoot = path.resolve(__dirname, '..');
const bankRoot = resolveBankRoot();
const outRoot = path.join(canvasRoot, 'demo', 'mock-bank');
const basePath = '/mock-bank';

const REMOTES = [
  { name: 'accounts-mfe', dir: 'accounts-mfe', prefix: 'mfe/accounts' },
  { name: 'account-detail-mfe', dir: 'account-detail-mfe', prefix: 'mfe/account-detail' },
  { name: 'nav-mfe', dir: 'nav-mfe', prefix: 'mfe/nav' },
  { name: 'transfer-mfe', dir: 'transfer-mfe', prefix: 'mfe/transfer' },
  { name: 'profile-mfe', dir: 'profile-mfe', prefix: 'mfe/profile' },
];

function resolveBankRoot() {
  const fromEnv =
    process.env.MOCK_BANK_ROOT?.trim() || process.env.DESIGN_CANVAS_TARGET?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.resolve(canvasRoot, '..', '..', 'angular', 'mock-bank-mfe');
}

function mustExist(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing ${label}: ${filePath}`);
  }
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

function rewriteIndexHtml(indexPath) {
  let html = fs.readFileSync(indexPath, 'utf8');
  html = html.replace(/<base href="\/">/, `<base href="${basePath}/">`);
  fs.writeFileSync(indexPath, html);
}

const shellBrowser = path.join(bankRoot, 'dist', 'bank-shell', 'browser');
mustExist(path.join(shellBrowser, 'index.html'), 'bank-shell index.html');

fs.rmSync(outRoot, { recursive: true, force: true });
copyDir(shellBrowser, outRoot);

for (const remote of REMOTES) {
  const src = path.join(bankRoot, 'dist', remote.dir, 'browser');
  const entryPath = path.join(src, 'remoteEntry.json');
  mustExist(entryPath, `${remote.name} remoteEntry.json`);
  const entry = JSON.parse(fs.readFileSync(entryPath, 'utf8'));
  if (entry.buildNotificationsEndpoint || entry.exposes?.some((e) => e.dev)) {
    throw new Error(
      `${remote.name} looks like an ng serve (dev) build. Stop mock-bank-mfe dev servers, run npm run build, then re-package.`,
    );
  }
  copyDir(src, path.join(outRoot, remote.prefix));
}

const manifest = Object.fromEntries(
  REMOTES.map((r) => [r.name, `${basePath}/${r.prefix}/remoteEntry.json`]),
);
fs.writeFileSync(
  path.join(outRoot, 'federation.manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
rewriteIndexHtml(path.join(outRoot, 'index.html'));

console.log(`[package-mock-bank] ${outRoot}`);
console.log(`[package-mock-bank] base ${basePath}/ ← ${bankRoot}`);
