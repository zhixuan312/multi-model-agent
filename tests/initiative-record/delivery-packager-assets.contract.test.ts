import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadDeliveryPackager } from '../../packages/core/src/initiative-record/index.js';

const EXPECTED = ['runnable-prototype@1', 'runnable-software@1'];

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
    const packagersRoot = join(root, 'packages/core/src/delivery-packagers');
    const compiled = (await import(pathToFileURL(distEntry).href)) as { loadDeliveryPackager(id: string): string };
    for (const id of EXPECTED) {
      const expectedPath = join(packagersRoot, id.split('@')[0]!, 'packager.md');
      expect(compiled.loadDeliveryPackager(id)).toBe(readFileSync(expectedPath, 'utf8'));
    }
    expect(() => compiled.loadDeliveryPackager('not-a-real-contract@1')).toThrow();
  });
});