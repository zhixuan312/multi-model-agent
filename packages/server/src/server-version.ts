import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

/**
 * The server package version, read from packages/server/package.json.
 *
 * Single source of truth — the HTTP server (http/server.ts, which pins it into
 * SERVER_VERSION) and the CLI entry (cli/index.ts) both read it through here so
 * the version string has exactly one implementation.
 */
export function readServerVersion(): string {
  try {
    const thisDir = dirname(fileURLToPath(import.meta.url)); // packages/server/src (or dist)
    const pkgPath = join(thisDir, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
