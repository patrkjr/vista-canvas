/**
 * Collapse concrete sibling URLs into parameterized route patterns so a crawl
 * does not create one screen per entity id (e.g. /accounts/everyday + /accounts/savings).
 */

export interface PathPatternParts {
  readonly segments: readonly string[];
  /** Indices that are dynamic (`:param`). */
  readonly dynamicIndexes: ReadonlySet<number>;
}

/** True for UUID / numeric / long opaque tokens. */
export function looksLikeIdSegment(segment: string): boolean {
  if (!segment) return false;
  if (/^\d+$/.test(segment)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) {
    return true;
  }
  if (/^[0-9a-f]{16,}$/i.test(segment)) return true;
  // Opaque tokens: mixed alnum with little structure, length ≥ 8, not a normal word route.
  if (/^[a-z0-9_-]{8,}$/i.test(segment) && /\d/.test(segment) && /[a-z]/i.test(segment)) {
    return true;
  }
  return false;
}

export function splitPath(path: string): string[] {
  const normalized = normalizePathOnly(path);
  if (normalized === '/') return [];
  return normalized.replace(/^\//, '').split('/').filter(Boolean);
}

export function joinPath(segments: readonly string[]): string {
  if (segments.length === 0) return '/';
  return `/${segments.join('/')}`;
}

/**
 * True when `child` extends `parent` by one or more segments
 * (`/` → `/accounts/x`, `/transfer` → `/transfer/confirm`).
 * Parameter tokens (`:id`) match any concrete segment.
 */
export function isPathChild(parent: string, child: string): boolean {
  const parentSegs = splitPath(parent);
  const childSegs = splitPath(child);
  if (childSegs.length <= parentSegs.length) return false;
  for (let i = 0; i < parentSegs.length; i += 1) {
    const p = parentSegs[i]!;
    const c = childSegs[i]!;
    if (p.startsWith(':') || c.startsWith(':')) continue;
    if (p !== c) return false;
  }
  return true;
}

/**
 * Infer which segment indexes vary among sibling paths of equal length.
 * A slot is parametric when ≥2 paths share the same length and differ only there
 * (or the slot always looks like an id).
 */
export function inferDynamicIndexes(paths: readonly string[]): Map<number, Set<number>> {
  /** segmentCount → indexes that vary */
  const byLength = new Map<number, string[][]>();
  for (const path of paths) {
    const segments = splitPath(path);
    const list = byLength.get(segments.length) ?? [];
    list.push(segments);
    byLength.set(segments.length, list);
  }

  const result = new Map<number, Set<number>>();
  for (const [length, group] of byLength) {
    const dynamic = new Set<number>();
    if (group.length === 0) {
      result.set(length, dynamic);
      continue;
    }

    // Top-level routes (/transfer vs /profile) are distinct screens, not params.
    // Only parameterize when there is a shared parent segment (length ≥ 2),
    // or a single leaf that looks like an opaque id.
    if (length < 2) {
      for (const segments of group) {
        const leaf = segments[0] ?? '';
        if (looksLikeIdSegment(leaf)) dynamic.add(0);
      }
      result.set(length, dynamic);
      continue;
    }

    for (let i = 0; i < length; i += 1) {
      const values = new Set(group.map((segments) => segments[i] ?? ''));
      const allLookLikeIds = [...values].every(looksLikeIdSegment);
      // Varying sibling slot → param. Single path with id-looking segment also params.
      if (values.size >= 2 || allLookLikeIds) dynamic.add(i);
    }

    // Pairwise: if two paths differ in exactly one index, that index is dynamic.
    for (let a = 0; a < group.length; a += 1) {
      for (let b = a + 1; b < group.length; b += 1) {
        const left = group[a]!;
        const right = group[b]!;
        const diffs: number[] = [];
        for (let i = 0; i < length; i += 1) {
          if (left[i] !== right[i]) diffs.push(i);
        }
        if (diffs.length === 1) dynamic.add(diffs[0]!);
      }
    }

    result.set(length, dynamic);
  }
  return result;
}

export function pathToPattern(
  path: string,
  dynamicByLength: Map<number, Set<number>>
): string {
  const segments = splitPath(path);
  const dynamic = dynamicByLength.get(segments.length) ?? new Set<number>();
  const patterned = segments.map((segment, index) => {
    if (!dynamic.has(index)) return segment;
    return `:${paramName(segments[index - 1], index)}`;
  });
  return joinPath(patterned);
}

export function patternToNodeId(pattern: string): string {
  if (pattern === '/') return 'screen-root';
  const slug = pattern
    .replace(/^\//, '')
    .replace(/:[^/]+/g, 'id')
    .replace(/\/+/g, '-')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
  return slug || 'screen-root';
}

/** Does concretePath match a route pattern with `:params`? */
export function pathMatchesPattern(concretePath: string, pattern: string): boolean {
  const concrete = splitPath(concretePath);
  const parts = splitPath(pattern);
  if (concrete.length !== parts.length) return false;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!;
    if (part.startsWith(':')) continue;
    if (part !== concrete[i]) return false;
  }
  return true;
}

export function titleForPattern(pattern: string, sampleTitle: string): string {
  // If sample title is generic / same as a leaf id, prefer a pattern-based label.
  const segments = splitPath(pattern);
  const lastStatic = [...segments].reverse().find((s) => !s.startsWith(':'));
  if (lastStatic) {
    const label = lastStatic
      .split('-')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
    // Prefer sample when it isn't just repeating a leaf slug.
    const leaf = splitPath(sampleTitle.toLowerCase().replace(/\s+/g, '/'));
    if (sampleTitle && !looksLikeIdSegment(sampleTitle) && leaf[0] !== lastStatic) {
      // Keep "Accounts", "Transfer Confirm", etc.
      if (!/^(account|item|detail|page)$/i.test(sampleTitle.trim())) {
        return sampleTitle;
      }
    }
    if (/s$/i.test(lastStatic) && segments.some((s) => s.startsWith(':'))) {
      // /accounts/:accountId → "Account"
      return label.replace(/s$/i, '');
    }
    return label;
  }
  return sampleTitle || 'Screen';
}

function paramName(previousSegment: string | undefined, index: number): string {
  if (!previousSegment || previousSegment.startsWith(':')) return `param${index}`;
  const singular = previousSegment.endsWith('s')
    ? previousSegment.slice(0, -1)
    : previousSegment;
  const cleaned = singular.replace(/[^a-zA-Z0-9]+/g, '');
  if (!cleaned) return `param${index}`;
  return `${cleaned.charAt(0).toLowerCase()}${cleaned.slice(1)}Id`;
}

function normalizePathOnly(pathname: string): string {
  if (!pathname || pathname === '/') return '/';
  const withSlash = pathname.startsWith('/') ? pathname : `/${pathname}`;
  const collapsed = withSlash.replace(/\/+/g, '/');
  return collapsed.length > 1 && collapsed.endsWith('/')
    ? collapsed.slice(0, -1)
    : collapsed;
}
