import { accessSync, constants } from 'node:fs';
import path from 'node:path';

/**
 * Optional Playwright storageState JSON path for authenticated hosts.
 * Set DESIGN_CANVAS_STORAGE_STATE to a file from `playwright codegen --save-storage=…`.
 */
export function resolveStorageStatePath(): string | undefined {
  const raw = process.env.DESIGN_CANVAS_STORAGE_STATE?.trim();
  if (!raw) return undefined;
  const resolved = path.resolve(raw);
  try {
    accessSync(resolved, constants.R_OK);
    return resolved;
  } catch {
    console.warn(
      `[design-canvas] DESIGN_CANVAS_STORAGE_STATE is set but not readable: ${resolved}`
    );
    return undefined;
  }
}
