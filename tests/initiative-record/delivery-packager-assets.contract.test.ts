import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
});