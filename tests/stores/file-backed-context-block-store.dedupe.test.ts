import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileBackedContextBlockStore } from '../../packages/core/src/stores/file-backed-context-block-store.js';

describe('FileBackedContextBlockStore content-hash dedupe', () => {
  it('returns the same UUID for identical content within the same project', () => {
    const home = mkdtempSync(join(tmpdir(), 'mma-dedupe-home-'));
    const cwd = mkdtempSync(join(tmpdir(), 'mma-dedupe-cwd-'));
    try {
      const store = new FileBackedContextBlockStore(cwd, { homeDir: home });
      const first = store.register('the same body', { ttlMs: 60_000 });
      const second = store.register('the same body', { ttlMs: 60_000 });
      expect(second.id).toBe(first.id);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('different content produces different UUIDs', () => {
    const home = mkdtempSync(join(tmpdir(), 'mma-dedupe-home-'));
    const cwd = mkdtempSync(join(tmpdir(), 'mma-dedupe-cwd-'));
    try {
      const store = new FileBackedContextBlockStore(cwd, { homeDir: home });
      const a = store.register('first content', { ttlMs: 60_000 });
      const b = store.register('second content', { ttlMs: 60_000 });
      expect(b.id).not.toBe(a.id);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('re-registration bumps mtime and resets ttlMs', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mma-dedupe-home-'));
    const cwd = mkdtempSync(join(tmpdir(), 'mma-dedupe-cwd-'));
    try {
      const store = new FileBackedContextBlockStore(cwd, { homeDir: home });
      const first = store.register('the same body', { ttlMs: 1_000 });
      // Reach into rootDir (test-only access — accept the cast for filesystem inspection).
      // We do NOT cast to access private contentPath/metaPath methods; instead we
      // reconstruct the paths from rootDir + id, which is a documented public layout.
      const root = (store as unknown as { rootDir: string }).rootDir;
      const fs = await import('node:fs');
      const path = await import('node:path');
      const contentPath = path.join(root, `${first.id}.txt`);
      const metaPath = path.join(root, `${first.id}.meta.json`);
      const mtimeBefore = statSync(contentPath).mtimeMs;
      await new Promise(r => setTimeout(r, 25));
      const second = store.register('the same body', { ttlMs: 999_999 });
      const mtimeAfter = statSync(contentPath).mtimeMs;
      expect(second.id).toBe(first.id);
      expect(mtimeAfter).toBeGreaterThan(mtimeBefore);
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      expect(meta.ttlMs).toBe(999_999);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});
