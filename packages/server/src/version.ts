import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Injected at compile time by `bun build --define MMAGENT_VERSION=...` (see
// scripts/build-binaries.mjs). Undefined in the node/dist and run-from-source
// paths, where the identifier is never substituted; the `typeof` guard below
// keeps that case from throwing a ReferenceError.
declare const MMAGENT_VERSION: string | undefined;

/**
 * Resolve the server package version across all distribution shapes.
 *
 * Standalone binaries (`bun build --compile`) carry no package.json on disk, so
 * `import.meta.url` points at a virtual path and the file read fails. For those
 * the version is baked in at compile time via `--define`. The node/dist and
 * run-from-source paths fall back to reading packages/server/package.json,
 * walking up from this module (src/ or dist/ → packages/server/).
 */
export function resolveServerVersion(): string {
  if (typeof MMAGENT_VERSION !== 'undefined' && MMAGENT_VERSION) return MMAGENT_VERSION;
  try {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(thisDir, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
