import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadDeliveryPackager } from '../../packages/core/src/initiative-record/index.js';

const EXPECTED = ['runnable-prototype@1', 'runnable-software@1'];

/**
 * A dist entry that exists but predates the source it was compiled from is not "installed
 * layout proof" — it's proof of a STALE build. Compare mtimes and fail loudly and distinctly
 * (never silently pass, never conflate with the "missing" error above) when the source is newer
 * than the compiled output.
 */
function assertDistFresh(distPath: string, sourcePath: string): void {
  const distMtimeMs = statSync(distPath).mtimeMs;
  const sourceMtimeMs = statSync(sourcePath).mtimeMs;
  if (sourceMtimeMs > distMtimeMs) {
    throw new Error(`dist is stale, rebuild: '${distPath}' predates its source '${sourcePath}' — run 'pnpm run build'`);
  }
}

describe('SPEC-007 packager asset bijection and package shipping', () => {
  it('maps only the two seeded Delivery Contracts to their committed packager assets, with no orphan', () => {
    const root = resolve(import.meta.dirname, '../..');
    const packagersRoot = join(root, 'packages/core/src/delivery-packagers');
    const files = EXPECTED.map((id) => join(packagersRoot, id.split('@')[0]!, 'packager.md'));
    expect(files.every(existsSync)).toBe(true);
    for (const [index, id] of EXPECTED.entries()) {
      // Comparing the returned text to this identifier's exact source path (rather
      // than only checking non-empty strings) catches a resolver that maps both ids
      // to the same asset.
      expect(loadDeliveryPackager(id)).toBe(readFileSync(files[index]!, 'utf8'));
    }
    expect(() => loadDeliveryPackager('not-a-real-contract@1')).toThrow();
    const actualDirs = readdirSync(packagersRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect(actualDirs.sort()).toEqual(EXPECTED.map((id) => id.split('@')[0]!).sort());
  });

  it('ships the packager assets to real npm consumers through package.json', () => {
    const root = resolve(import.meta.dirname, '../..');
    const manifest = JSON.parse(readFileSync(join(root, 'packages/core/package.json'), 'utf8')) as { files: string[] };
    expect(manifest.files).toContain('src/delivery-packagers');
  });

  // The two tests above run the resolver from source (`packages/core/src/...`), the shape every
  // Vitest run uses, but not the shape a real npm consumer loads. This test instead imports the
  // COMPILED resolver from `packages/core/dist/...` (built by `pnpm run build`) and exercises it
  // directly, proving the installed/dist layout: `dist/delivery-packagers/` never exists (tsc
  // does not copy `.md` files), so the compiled resolver must fall back to its
  // package-root-relative `src/delivery-packagers` candidate and still read every packaged asset
  // correctly through that path. It does NOT perform an actual `npm pack`/install round trip —
  // it reads the real `dist/` output already produced by the build, which is the practical proxy
  // available in this suite for "what an npm consumer's `node_modules` layout resolves to".
  it('reads every packaged asset through the compiled dist resolver (installed-layout proof)', async () => {
    const root = resolve(import.meta.dirname, '../..');
    const distEntry = join(root, 'packages/core/dist/initiative-record/delivery-packagers.js');
    if (!existsSync(distEntry)) {
      throw new Error(`compiled dist output missing at '${distEntry}' — run 'pnpm run build' before this test`);
    }
    assertDistFresh(distEntry, join(root, 'packages/core/src/initiative-record/delivery-packagers.ts'));
    const packagersRoot = join(root, 'packages/core/src/delivery-packagers');
    const compiled = (await import(pathToFileURL(distEntry).href)) as { loadDeliveryPackager(id: string): string };
    for (const id of EXPECTED) {
      const expectedPath = join(packagersRoot, id.split('@')[0]!, 'packager.md');
      expect(compiled.loadDeliveryPackager(id)).toBe(readFileSync(expectedPath, 'utf8'));
    }
    expect(() => compiled.loadDeliveryPackager('not-a-real-contract@1')).toThrow();
  });

  it('fails with a distinct "dist is stale, rebuild" message when the compiled dist predates its source', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-dist-freshness-'));
    try {
      const distPath = join(dir, 'delivery-packagers.js');
      const sourcePath = join(dir, 'delivery-packagers.ts');
      writeFileSync(distPath, '// stale compiled output');
      writeFileSync(sourcePath, '// newer source');
      const past = new Date('2020-01-01T00:00:00.000Z');
      const future = new Date('2030-01-01T00:00:00.000Z');
      utimesSync(distPath, past, past);
      utimesSync(sourcePath, future, future);
      expect(() => assertDistFresh(distPath, sourcePath)).toThrow('dist is stale, rebuild');
      // A dist newer than its source is fresh and must not throw.
      utimesSync(distPath, future, future);
      utimesSync(sourcePath, past, past);
      expect(() => assertDistFresh(distPath, sourcePath)).not.toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
