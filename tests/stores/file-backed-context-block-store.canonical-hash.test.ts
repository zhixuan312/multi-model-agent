import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileBackedContextBlockStore } from '../../packages/core/src/stores/file-backed-context-block-store.js';

describe('FileBackedContextBlockStore canonical hash', () => {
  it('hashes the canonical (realpath-resolved) cwd, so a symlink and its target produce the same projectHash', () => {
    const home = mkdtempSync(join(tmpdir(), 'mma-store-hash-home-'));
    const realDir = mkdtempSync(join(tmpdir(), 'mma-store-hash-real-'));
    const linkDir = join(tmpdir(), `mma-store-hash-link-${Date.now()}`);
    symlinkSync(realDir, linkDir);
    try {
      const storeViaReal = new FileBackedContextBlockStore(realDir, { homeDir: home });
      const storeViaLink = new FileBackedContextBlockStore(linkDir, { homeDir: home });
      const realRoot = (storeViaReal as unknown as { rootDir: string }).rootDir;
      const linkRoot = (storeViaLink as unknown as { rootDir: string }).rootDir;
      expect(realRoot).toBe(linkRoot);
    } finally {
      rmSync(linkDir, { force: true });
      rmSync(realDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});
