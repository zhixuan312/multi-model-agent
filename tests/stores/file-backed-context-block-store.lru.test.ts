import { describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileBackedContextBlockStore } from '../../packages/core/src/stores/file-backed-context-block-store.js';

describe('FileBackedContextBlockStore inner LRU eviction', () => {
  it('evicts oldest-mtime block when maxBlocksPerProject is reached', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mma-lru-home-'));
    const cwd = mkdtempSync(join(tmpdir(), 'mma-lru-cwd-'));
    try {
      const store = new FileBackedContextBlockStore(cwd, { homeDir: home, maxBlocksPerProject: 3 });
      const a = store.register('content-a', { ttlMs: 60_000 });
      await new Promise(r => setTimeout(r, 5));
      const b = store.register('content-b', { ttlMs: 60_000 });
      await new Promise(r => setTimeout(r, 5));
      const c = store.register('content-c', { ttlMs: 60_000 });
      await new Promise(r => setTimeout(r, 5));
      // 4th block must trigger eviction of the oldest-mtime (`a`)
      const d = store.register('content-d', { ttlMs: 60_000 });
      const root = (store as unknown as { rootDir: string }).rootDir;
      const files = readdirSync(root).filter(f => f.endsWith('.txt'));
      expect(files.length).toBe(3);
      const remainingIds = new Set(files.map(f => f.slice(0, -'.txt'.length)));
      expect(remainingIds.has(a.id)).toBe(false); // evicted
      expect(remainingIds.has(b.id)).toBe(true);
      expect(remainingIds.has(c.id)).toBe(true);
      expect(remainingIds.has(d.id)).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});
