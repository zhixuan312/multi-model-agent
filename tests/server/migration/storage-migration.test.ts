import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateStorage } from '../../../packages/server/src/migration/storage-migration.js';

function mkOldProject(oldRoot: string, hash: string, mtimeSeconds: number) {
  const dir = join(oldRoot, hash);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'block.txt'), 'x');
  utimesSync(join(dir, 'block.txt'), mtimeSeconds, mtimeSeconds);
  // Match the recency calculation: impl reads max(file mtime) when files exist.
  // Setting just file mtime is sufficient for non-empty dirs.
}

describe('migrateStorage', () => {
  it('moves the maxProjects most-recent project dirs from old path to new, drops the rest, removes old root', () => {
    const home = mkdtempSync(join(tmpdir(), 'mma-mig-'));
    const oldRoot = join(home, '.multi-model-agent', 'context-blocks');
    const newRoot = join(home, '.multi-model', 'context-blocks');
    mkdirSync(oldRoot, { recursive: true });
    try {
      mkOldProject(oldRoot, 'aaa1', 1_000_000); // oldest, will drop
      mkOldProject(oldRoot, 'aaa2', 1_000_001); // oldest, will drop
      mkOldProject(oldRoot, 'aaa3', 1_000_002);
      mkOldProject(oldRoot, 'aaa4', 1_000_003);
      mkOldProject(oldRoot, 'aaa5', 1_000_004);

      const result = migrateStorage(home, 3);

      expect(result.migrated).toBe(3);
      expect(result.dropped).toBe(2);
      const inNew = readdirSync(newRoot).sort();
      expect(inNew).toEqual(['aaa3', 'aaa4', 'aaa5']);
      // Old root must be removed entirely (not just its contents)
      expect(existsSync(join(home, '.multi-model-agent'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('is a no-op when old path does not exist', () => {
    const home = mkdtempSync(join(tmpdir(), 'mma-mig-'));
    try {
      const result = migrateStorage(home, 500);
      expect(result.migrated).toBe(0);
      expect(result.dropped).toBe(0);
      // No new path created either
      expect(existsSync(join(home, '.multi-model'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('PRESERVES the old root when any rename fails (no data loss on partial migration)', () => {
    const home = mkdtempSync(join(tmpdir(), 'mma-mig-'));
    const oldRoot = join(home, '.multi-model-agent', 'context-blocks');
    const newRoot = join(home, '.multi-model', 'context-blocks');
    mkdirSync(oldRoot, { recursive: true });
    try {
      mkOldProject(oldRoot, 'aaa1', 1_000_000);
      mkOldProject(oldRoot, 'aaa2', 1_000_001);
      // Pre-create a colliding target so renameSync(aaa2) throws ENOTEMPTY/EEXIST.
      mkdirSync(join(newRoot, 'aaa2'), { recursive: true });
      writeFileSync(join(newRoot, 'aaa2', 'pre-existing.txt'), 'guard');

      const result = migrateStorage(home, 5);

      // aaa1 moved successfully. aaa2 failed (target collision).
      expect(result.migrated).toBeLessThan(2); // at least one failure recorded
      // CRITICAL: old root MUST still exist because at least one project failed.
      expect(existsSync(join(home, '.multi-model-agent'))).toBe(true);
      // The failed project (aaa2) MUST still be in the old tree, not destroyed.
      expect(existsSync(join(oldRoot, 'aaa2'))).toBe(true);
      // The original colliding file in the new root is untouched.
      expect(existsSync(join(newRoot, 'aaa2', 'pre-existing.txt'))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('is a no-op when both old and new exist (already-migrated machine)', () => {
    const home = mkdtempSync(join(tmpdir(), 'mma-mig-'));
    const oldRoot = join(home, '.multi-model-agent', 'context-blocks');
    const newRoot = join(home, '.multi-model', 'context-blocks');
    mkdirSync(oldRoot, { recursive: true });
    mkdirSync(newRoot, { recursive: true });
    try {
      const result = migrateStorage(home, 500);
      expect(result.migrated).toBe(0);
      expect(result.dropped).toBe(0);
      expect(existsSync(oldRoot)).toBe(true); // we don't touch it on no-op
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
