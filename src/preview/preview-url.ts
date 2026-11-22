/**
 * Resolve a concrete URL path for iframe mounts.
 * Prefer explicit previewPath; fall back to route only when it has no :params.
 */
export function resolvePreviewPath(route: string, previewPath?: string): string | null {
  if (previewPath && previewPath.trim()) {
    return normalizePath(previewPath);
  }
  if (route.includes(':')) return null;
  return normalizePath(route);
}

export function buildPreviewUrl(appOrigin: string, previewPath: string): string {
  const origin = appOrigin.replace(/\/$/, '');
  const path = normalizePath(previewPath);
  return `${origin}${path === '/' ? '/' : path}`;
}

export function resolveAppOrigin(explicit?: string): string {
  const fromEnv = readEnv('DESIGN_CANVAS_APP_ORIGIN');
  const value = explicit?.trim() || fromEnv || 'http://localhost:4200';
  return value.replace(/\/$/, '');
}

function readEnv(name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.[name]?.trim();
}

function normalizePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '/') return '/';
  // Preserve query strings on preview paths (e.g. /accounts/everyday?fixture=empty_transactions).
  const path = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return path;
}
