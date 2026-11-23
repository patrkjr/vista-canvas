import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

import { resolveStorageStatePath } from './playwright-auth.js';

export type SnapshotColorScheme = 'light' | 'dark';

export interface SnapshotRequest {
  readonly previewUrl: string;
  readonly width: number;
  readonly height: number;
  readonly colorScheme: SnapshotColorScheme;
}

export interface SnapshotResult {
  readonly bytes: Buffer;
  readonly contentType: 'image/webp';
  readonly fromCache: boolean;
}

interface CacheEntry {
  readonly key: string;
  readonly bytes: Buffer;
}

const DEFAULT_SETTLE_MS = 800;
const DEFAULT_GOTO_TIMEOUT_MS = 15_000;
const DEFAULT_CACHE_CAPACITY = 128;
/** Backing pixels per CSS px. 3× keeps meso stills sharp through ~500% canvas zoom on retina. */
const DEFAULT_DEVICE_SCALE_FACTOR = 3;

/**
 * Sequential Playwright captures for meso stills.
 * One Chrome page, 2× device scale, WebP output, in-memory LRU.
 */
export class SnapshotService {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private queue: Promise<void> = Promise.resolve();
  private readonly cache = new Map<string, CacheEntry>();
  private readonly settleMs: number;
  private readonly gotoTimeoutMs: number;
  private readonly cacheCapacity: number;
  private readonly deviceScaleFactor: number;
  private closed = false;

  constructor(options?: {
    settleMs?: number;
    gotoTimeoutMs?: number;
    cacheCapacity?: number;
    deviceScaleFactor?: number;
  }) {
    this.settleMs = options?.settleMs ?? Number(process.env.SNAPSHOT_SETTLE_MS ?? DEFAULT_SETTLE_MS);
    this.gotoTimeoutMs =
      options?.gotoTimeoutMs ?? Number(process.env.SNAPSHOT_GOTO_TIMEOUT_MS ?? DEFAULT_GOTO_TIMEOUT_MS);
    this.cacheCapacity = options?.cacheCapacity ?? DEFAULT_CACHE_CAPACITY;
    this.deviceScaleFactor =
      options?.deviceScaleFactor ??
      Number(process.env.SNAPSHOT_DEVICE_SCALE_FACTOR ?? DEFAULT_DEVICE_SCALE_FACTOR);
  }

  async capture(request: SnapshotRequest): Promise<SnapshotResult> {
    if (this.closed) throw new Error('SnapshotService is closed');
    const key = cacheKey(request, this.deviceScaleFactor);
    const cached = this.cache.get(key);
    if (cached) {
      // Refresh LRU order.
      this.cache.delete(key);
      this.cache.set(key, cached);
      return { bytes: cached.bytes, contentType: 'image/webp', fromCache: true };
    }

    return this.enqueue(async () => {
      const again = this.cache.get(key);
      if (again) {
        this.cache.delete(key);
        this.cache.set(key, again);
        return { bytes: again.bytes, contentType: 'image/webp', fromCache: true };
      }

      const page = await this.ensurePage();
      await page.setViewportSize({ width: request.width, height: request.height });
      await page.emulateMedia({ colorScheme: request.colorScheme });
      await page.goto(request.previewUrl, {
        waitUntil: 'load',
        timeout: this.gotoTimeoutMs,
      });
      if (this.settleMs > 0) {
        await delay(this.settleMs);
      }

      const bytes = Buffer.from(
        await page.screenshot({
          type: 'webp',
          quality: 82,
          fullPage: false,
        })
      );

      this.putCache(key, bytes);
      return { bytes, contentType: 'image/webp', fromCache: false };
    });
  }

  invalidate(predicate?: (key: string) => boolean): number {
    if (!predicate) {
      const count = this.cache.size;
      this.cache.clear();
      return count;
    }
    let removed = 0;
    for (const key of [...this.cache.keys()]) {
      if (!predicate(key)) continue;
      this.cache.delete(key);
      removed += 1;
    }
    return removed;
  }

  async close(): Promise<void> {
    this.closed = true;
    // Drain in-flight captures before tearing down the browser.
    await this.queue.catch(() => undefined);
    const page = this.page;
    const context = this.context;
    const browser = this.browser;
    this.page = null;
    this.context = null;
    this.browser = null;
    this.cache.clear();
    await page?.close().catch(() => undefined);
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }

  private putCache(key: string, bytes: Buffer): void {
    this.cache.set(key, { key, bytes });
    while (this.cache.size > this.cacheCapacity) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async ensurePage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;

    if (!this.browser || !this.browser.isConnected()) {
      this.browser = await chromium.launch({
        channel: 'chrome',
        headless: true,
      });
      this.context = null;
    }

    if (!this.context) {
      const storageState = resolveStorageStatePath();
      this.context = await this.browser.newContext({
        deviceScaleFactor: this.deviceScaleFactor,
        ...(storageState ? { storageState } : {}),
      });
    }

    this.page = await this.context.newPage();
    return this.page;
  }
}

export function cacheKey(request: SnapshotRequest, deviceScaleFactor?: number): string {
  const dsf = deviceScaleFactor ?? DEFAULT_DEVICE_SCALE_FACTOR;
  return `${request.previewUrl}|${request.width}x${request.height}|${request.colorScheme}|dsf${dsf}`;
}

export function parseColorScheme(value: string | null | undefined): SnapshotColorScheme {
  return value === 'dark' ? 'dark' : 'light';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
