/**
 * tests/cli/binary-version.test.ts
 *
 * Guards the two halves of compiled-binary version resolution:
 *   1. resolveServerVersion() returns a real version on the node/dist path
 *      (reads packages/server/package.json), never the '0.0.0' fallback.
 *   2. scripts/build-binaries.mjs injects MMAGENT_VERSION via `bun build
 *      --define`, the mechanism the standalone binary relies on (it has no
 *      package.json on disk). Without the define, `mmagent --version` inside a
 *      compiled binary silently reports 0.0.0 — the regression this locks.
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveServerVersion } from '../../packages/server/src/version.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('binary version resolution', () => {
  it('resolveServerVersion reads the real package version on the dist/source path', () => {
    const pkg = JSON.parse(
      readFileSync(join(ROOT, 'packages/server/package.json'), 'utf8'),
    ) as { version: string };
    const resolved = resolveServerVersion();
    expect(resolved).toBe(pkg.version);
    expect(resolved).not.toBe('0.0.0');
  });

  it('build-binaries injects MMAGENT_VERSION via --define so binaries report a real version', () => {
    const script = readFileSync(join(ROOT, 'scripts/build-binaries.mjs'), 'utf8');
    expect(script).toContain('--define=MMAGENT_VERSION=');
  });
});
