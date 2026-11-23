import { chromium, type Page } from 'playwright';

import {
  inferDynamicIndexes,
  isPathChild,
  pathMatchesPattern,
  pathToPattern,
  patternToNodeId,
  splitPath,
  titleForPattern,
} from './path-patterns.js';
import { resolveStorageStatePath } from './playwright-auth.js';
import { buildPreviewUrl } from './preview-url.js';

const DEFAULT_MAX_PAGES = 30;
const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_GOTO_TIMEOUT_MS = 15_000;
/**
 * Federation remotes often need ~2s after `load` before list links appear.
 * Avoid `networkidle` — it can fire too early on SPA shells.
 */
const DEFAULT_SETTLE_MS = 2000;

const SKIP_PATH_PREFIXES = ['/__canvas/', '/assets/', '/media/', '/api/'];
const SKIP_PATH_EXACT = new Set(['/favicon.ico', '/robots.txt']);
const SKIP_PATH_KEYWORDS = ['logout', 'sign-out', 'signout', 'log-out'];

export interface DiscoveredScreen {
  readonly id: string;
  readonly title: string;
  readonly route: string;
  readonly previewPath: string;
  readonly mfe: string;
  readonly depth: number;
}

export interface DiscoveredEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly kind: 'flow' | 'nav';
  readonly label?: string;
}

export interface RuntimeMapResult {
  readonly screens: readonly DiscoveredScreen[];
  /** In-product flow edges between screens (not chrome/menu). */
  readonly edges: readonly DiscoveredEdge[];
  /**
   * Screen ids that are global menu destinations (appear on most pages).
   * The store attaches these as `nav` edges from a module hub.
   */
  readonly chromeDestinations: readonly string[];
  readonly remotes: Readonly<Record<string, string>>;
}

export interface RuntimeMapperOptions {
  readonly appOrigin: string;
  readonly maxPages?: number;
  readonly maxDepth?: number;
  readonly gotoTimeoutMs?: number;
  readonly settleMs?: number;
}

/**
 * Crawl a running host app via Playwright. Does not read MFE source —
 * federation remotes may load from CDN inside the host.
 */
export async function mapRunningApp(
  options: RuntimeMapperOptions
): Promise<RuntimeMapResult> {
  const origin = options.appOrigin.replace(/\/$/, '');
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const gotoTimeoutMs = options.gotoTimeoutMs ?? DEFAULT_GOTO_TIMEOUT_MS;
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;

  const remotes = await fetchFederationManifest(origin);
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
  });

  try {
    const storageState = resolveStorageStatePath();
    const context = await browser.newContext(
      storageState ? { storageState } : undefined
    );
    const page = await context.newPage();
    const rawScreens: DiscoveredScreen[] = [];
    /** Paths we already opened (or decided not to open as redundant siblings). */
    const visitedOrSkipped = new Set<string>();
    /** Visited screen paths only — sibling checks must not use skipped ids as anchors. */
    const visitedPaths = new Set<string>();
    /** Visited + skipped siblings — used to infer `:param` slots without opening every id. */
    const observedPaths = new Set<string>(['/']);
    /** Per visited page → outbound same-origin paths (for chrome vs flow classification). */
    const linksByPage = new Map<string, Set<string>>();
    const queue: Array<{ path: string; depth: number }> = [{ path: '/', depth: 0 }];

    while (queue.length > 0 && rawScreens.length < maxPages) {
      const next = queue.shift();
      if (!next) break;
      if (visitedOrSkipped.has(next.path)) continue;
      if (next.depth > maxDepth) continue;
      if (!isCrawlablePath(next.path)) continue;

      observedPaths.add(next.path);
      if (isSiblingOfKnown(next.path, visitedPaths)) {
        // Same screen template, different entity id — do not visit.
        visitedOrSkipped.add(next.path);
        continue;
      }

      visitedOrSkipped.add(next.path);
      visitedPaths.add(next.path);
      const previewUrl = buildPreviewUrl(origin, next.path);
      const networkUrls: string[] = [];
      const onRequest = (request: { url: () => string }): void => {
        networkUrls.push(request.url());
      };
      page.on('request', onRequest);

      try {
        await page.goto(previewUrl, {
          waitUntil: 'load',
          timeout: gotoTimeoutMs,
        });
        if (settleMs > 0) await delay(settleMs);
      } catch (error) {
        page.off('request', onRequest);
        console.warn(`[runtime-mapper] failed to open ${previewUrl}:`, errorMessage(error));
        continue;
      }

      page.off('request', onRequest);

      const title = await readPageTitle(page);
      const mfe = inferMfe(networkUrls, remotes) ?? 'unknown';
      const id = pathToNodeId(next.path);
      const screen: DiscoveredScreen = {
        id,
        title,
        route: next.path,
        previewPath: next.path,
        mfe,
        depth: next.depth,
      };
      rawScreens.push(screen);

      const links = await collectSameOriginLinks(page, origin);
      linksByPage.set(next.path, new Set(links));

      if (next.depth >= maxDepth) continue;

      // Only treat *queued or visited* paths as sibling anchors — never skipped ids.
      const siblingAnchors = new Set([
        ...visitedPaths,
        ...queue.map((item) => item.path),
      ]);
      for (const link of links) {
        observedPaths.add(link);
        if (visitedOrSkipped.has(link) || queue.some((item) => item.path === link)) continue;
        if (!isCrawlablePath(link)) continue;
        if (isSiblingOfKnown(link, siblingAnchors)) {
          // Remember for pattern inference, but do not block the queued exemplar.
          visitedOrSkipped.add(link);
          continue;
        }
        if (rawScreens.length + queue.length >= maxPages) break;
        siblingAnchors.add(link);
        queue.push({ path: link, depth: next.depth + 1 });
      }
    }

    await context.close();

    const chromePaths = classifyChromeDestinations(linksByPage);
    const flowEdgesRaw = buildFlowEdges(linksByPage, chromePaths);
    const collapsed = collapseParameterizedScreens(rawScreens, flowEdgesRaw, [...observedPaths]);
    const pathToScreenId = buildPathToScreenIdMap(collapsed.screens, [...observedPaths]);
    const chromeDestinations = [
      ...new Set(
        [...chromePaths]
          .map((path) => pathToScreenId.get(normalizePath(path)))
          .filter((id): id is string => typeof id === 'string')
      ),
    ];

    return {
      screens: collapsed.screens,
      edges: collapsed.edges,
      chromeDestinations,
      remotes,
    };
  } finally {
    await browser.close();
  }
}

/**
 * Destinations that appear on ≥2 pages and ≥50% of visited pages = shared chrome/menu.
 */
export function classifyChromeDestinations(
  linksByPage: ReadonlyMap<string, ReadonlySet<string>>
): Set<string> {
  const pageCount = linksByPage.size;
  if (pageCount < 2) return new Set();

  const frequency = new Map<string, number>();
  for (const links of linksByPage.values()) {
    for (const link of links) {
      const path = normalizePath(link);
      frequency.set(path, (frequency.get(path) ?? 0) + 1);
    }
  }

  const chrome = new Set<string>();
  for (const [path, count] of frequency) {
    if (count >= 2 && count / pageCount >= 0.5) chrome.add(path);
  }
  return chrome;
}

/**
 * Screen→screen flow only: path children, or links seen on at most one page.
 * Chrome destinations are excluded (owned by the nav hub).
 */
export function buildFlowEdges(
  linksByPage: ReadonlyMap<string, ReadonlySet<string>>,
  chromePaths: ReadonlySet<string>
): DiscoveredEdge[] {
  const frequency = new Map<string, number>();
  for (const links of linksByPage.values()) {
    for (const link of links) {
      const path = normalizePath(link);
      frequency.set(path, (frequency.get(path) ?? 0) + 1);
    }
  }

  const edges: DiscoveredEdge[] = [];
  for (const [fromPathRaw, links] of linksByPage) {
    const fromPath = normalizePath(fromPathRaw);
    const fromId = pathToNodeId(fromPath);
    for (const link of links) {
      const toPath = normalizePath(link);
      if (toPath === fromPath) continue;
      if (chromePaths.has(toPath)) continue;

      const localOnly = (frequency.get(toPath) ?? 0) <= 1;
      if (!localOnly && !isPathChild(fromPath, toPath)) continue;

      const toId = pathToNodeId(toPath);
      if (fromId === toId) continue;
      edges.push({
        id: `edge-${fromId}-to-${toId}`,
        from: fromId,
        to: toId,
        kind: 'flow',
      });
    }
  }
  return dedupeEdges(edges);
}

function buildPathToScreenIdMap(
  screens: readonly DiscoveredScreen[],
  observedPaths: readonly string[]
): Map<string, string> {
  const dynamicByLength = inferDynamicIndexes([
    ...screens.map((screen) => screen.previewPath),
    ...observedPaths.map((path) => normalizePath(path)),
  ]);
  const map = new Map<string, string>();
  for (const screen of screens) {
    map.set(normalizePath(screen.previewPath), screen.id);
    map.set(normalizePath(screen.route), screen.id);
  }
  for (const path of observedPaths) {
    const normalized = normalizePath(path);
    if (map.has(normalized)) continue;
    const pattern = pathToPattern(normalized, dynamicByLength);
    const match = screens.find(
      (screen) =>
        screen.route === pattern ||
        pathMatchesPattern(normalized, screen.route) ||
        normalizePath(screen.previewPath) === normalized
    );
    if (match) map.set(normalized, match.id);
  }
  return map;
}

/**
 * Group concrete paths that only differ by id-like / varying segments into one
 * screen with a parameterized `route` and a single concrete `previewPath`.
 */
export function collapseParameterizedScreens(
  screens: readonly DiscoveredScreen[],
  edges: readonly DiscoveredEdge[],
  observedPaths: readonly string[] = []
): { screens: DiscoveredScreen[]; edges: DiscoveredEdge[] } {
  if (screens.length === 0) return { screens: [], edges: [] };

  const pathsForInference = [
    ...new Set([
      ...screens.map((screen) => screen.previewPath),
      ...observedPaths.map((path) => normalizePath(path)),
    ]),
  ];
  const dynamicByLength = inferDynamicIndexes(pathsForInference);
  const byPattern = new Map<string, DiscoveredScreen[]>();
  for (const screen of screens) {
    const pattern = pathToPattern(screen.previewPath, dynamicByLength);
    const group = byPattern.get(pattern) ?? [];
    group.push(screen);
    byPattern.set(pattern, group);
  }

  const collapsed: DiscoveredScreen[] = [];
  const idRemap = new Map<string, string>();

  for (const [pattern, group] of byPattern) {
    const sorted = [...group].sort((a, b) => a.depth - b.depth || a.previewPath.localeCompare(b.previewPath));
    const primary = sorted[0]!;
    const id = pattern === primary.previewPath ? primary.id : patternToNodeId(pattern);
    const route = pattern;
    const title = titleForPattern(pattern, primary.title);
    collapsed.push({
      id,
      title,
      route,
      previewPath: primary.previewPath,
      mfe: primary.mfe,
      depth: primary.depth,
    });
    for (const member of group) {
      idRemap.set(member.id, id);
    }
  }

  const remappedEdges: DiscoveredEdge[] = [];
  for (const edge of edges) {
    const from = idRemap.get(edge.from) ?? edge.from;
    const to = idRemap.get(edge.to) ?? edge.to;
    if (from === to) continue;
    remappedEdges.push({
      ...edge,
      id: `edge-${from}-to-${to}`,
      from,
      to,
    });
  }

  return { screens: collapsed, edges: dedupeEdges(remappedEdges) };
}

/** Exported for store merge cleanup of leftover sibling screens. */
export { pathMatchesPattern, pathToPattern, inferDynamicIndexes };

export function pathToNodeId(previewPath: string): string {
  const normalized = normalizePath(previewPath);
  if (normalized === '/') return 'screen-root';
  const slug = normalized
    .replace(/^\//, '')
    .replace(/\/+/g, '-')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
  return slug || 'screen-root';
}

export function normalizePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '/';
  try {
    if (trimmed.includes('://')) {
      const url = new URL(trimmed);
      return normalizePathOnly(url.pathname);
    }
  } catch {
    // fall through
  }
  const pathOnly = trimmed.split(/[?#]/)[0] ?? '/';
  return normalizePathOnly(pathOnly);
}

function normalizePathOnly(pathname: string): string {
  if (!pathname || pathname === '/') return '/';
  const withSlash = pathname.startsWith('/') ? pathname : `/${pathname}`;
  const collapsed = withSlash.replace(/\/+/g, '/');
  return collapsed.length > 1 && collapsed.endsWith('/')
    ? collapsed.slice(0, -1)
    : collapsed;
}

function isCrawlablePath(path: string): boolean {
  const normalized = normalizePath(path);
  if (SKIP_PATH_EXACT.has(normalized)) return false;
  if (SKIP_PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return false;
  const lower = normalized.toLowerCase();
  if (SKIP_PATH_KEYWORDS.some((keyword) => lower.includes(keyword))) return false;
  return true;
}

async function fetchFederationManifest(
  origin: string
): Promise<Record<string, string>> {
  try {
    const response = await fetch(`${origin}/federation.manifest.json`);
    if (!response.ok) return {};
    const payload: unknown = await response.json();
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      return {};
    }
    const remotes: Record<string, string> = {};
    for (const [name, value] of Object.entries(payload)) {
      if (typeof value === 'string' && value.trim()) remotes[name] = value.trim();
    }
    return remotes;
  } catch {
    return {};
  }
}

function inferMfe(
  networkUrls: readonly string[],
  remotes: Readonly<Record<string, string>>
): string | null {
  if (Object.keys(remotes).length === 0) return null;
  const hits = new Map<string, number>();
  for (const url of networkUrls) {
    for (const [name, entry] of Object.entries(remotes)) {
      const markers = [name, entry];
      if (markers.some((marker) => marker && url.includes(marker))) {
        hits.set(name, (hits.get(name) ?? 0) + 1);
      }
    }
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [name, count] of hits) {
    if (count > bestCount) {
      best = name;
      bestCount = count;
    }
  }
  return best;
}

async function collectSameOriginLinks(page: Page, origin: string): Promise<string[]> {
  const anchorHrefs = await page.$$eval('a[href]', (anchors) =>
    anchors.map((anchor) => anchor.getAttribute('href') ?? '').filter(Boolean)
  );

  // Angular may put routerLink on buttons (ng-reflect-router-link).
  const routerHrefs = await page
    .$$eval(
      '[routerlink], [ng-reflect-router-link], [data-router-link]',
      (elements) =>
        elements.map((el) => {
          const reflected =
            el.getAttribute('ng-reflect-router-link') ||
            el.getAttribute('routerlink') ||
            el.getAttribute('data-router-link') ||
            '';
          if (!reflected) return '';
          // Angular may serialize as "/transfer,confirm" or "['/transfer','confirm']"
          const cleaned = reflected
            .replace(/^\[|\]$/g, '')
            .split(',')
            .map((part: string) => part.trim().replace(/^['"]|['"]$/g, ''))
            .filter(Boolean);
          if (cleaned.length === 0) return '';
          const joined = cleaned.join('/').replace(/\/+/g, '/');
          return cleaned[0]!.startsWith('/') ? joined : `/${joined}`;
        })
    )
    .catch(() => [] as string[]);

  const paths = new Set<string>();
  for (const href of [...anchorHrefs, ...routerHrefs]) {
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) {
      continue;
    }
    try {
      const url = new URL(href, origin);
      if (url.origin !== new URL(origin).origin) continue;
      // Drop query strings — fixtures stay curated, not crawled.
      const path = normalizePath(url.pathname);
      if (isCrawlablePath(path)) paths.add(path);
    } catch {
      // ignore invalid hrefs
    }
  }
  return [...paths];
}

async function readPageTitle(page: Page): Promise<string> {
  const documentTitle = (await page.title()).trim();
  if (documentTitle) {
    const cleaned = documentTitle.split(/[•|·\-–—]/)[0]?.trim();
    if (cleaned) return cleaned;
  }
  const heading = await page
    .$eval('h1, h2, [data-screen]', (el) => el.textContent?.trim() ?? '')
    .catch(() => '');
  if (heading) return heading.slice(0, 80);
  const path = normalizePath(new URL(page.url()).pathname);
  if (path === '/') return 'Home';
  return path
    .replace(/^\//, '')
    .split('/')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function dedupeEdges(edges: readonly DiscoveredEdge[]): DiscoveredEdge[] {
  const byKey = new Map<string, DiscoveredEdge>();
  for (const edge of edges) {
    const key = `${edge.from}->${edge.to}`;
    if (!byKey.has(key)) byKey.set(key, edge);
  }
  return [...byKey.values()];
}

/**
 * Same length, share a static prefix, differ in exactly one segment →
 * redundant entity instance (e.g. /accounts/everyday vs /accounts/savings).
 * Top-level routes (/transfer vs /profile) are NOT siblings.
 */
function isSiblingOfKnown(candidate: string, known: Iterable<string>): boolean {
  const candidateSegments = splitPath(candidate);
  // Need a shared parent segment — length 1 paths are distinct product routes.
  if (candidateSegments.length < 2) return false;
  for (const other of known) {
    const otherSegments = splitPath(other);
    if (otherSegments.length !== candidateSegments.length) continue;
    let diffs = 0;
    let shared = 0;
    for (let i = 0; i < candidateSegments.length; i += 1) {
      if (candidateSegments[i] === otherSegments[i]) shared += 1;
      else {
        diffs += 1;
        if (diffs > 1) break;
      }
    }
    if (diffs === 1 && shared >= 1) return true;
  }
  return false;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
