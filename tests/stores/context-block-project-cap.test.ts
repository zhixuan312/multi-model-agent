import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sweepProjectCap } from '../../packages/core/src/stores/context-block-project-cap.js';

function mkProject(root: string, hash: string, mtimeSeconds: number) {
  const dir = join(root, hash);
  mkdirSync(dir, { recursive: true });
  // Give it a file so it's non-empty (matches real usage). Set the FILE
  // mtime — the implementation reads max(file-mtime) for non-empty dirs and
  // falls back to dir mtime only when the dir has zero files. Setting only
  // the dir mtime here would not be picked up by the impl, since
  // writeFileSync above produces a fresh "now"-mtime placeholder.txt that
  // dominates.
  const placeholder = join(dir, 'placeholder.txt');
  writeFileSync(placeholder, 'x');
  utimesSync(placeholder, mtimeSeconds, mtimeSeconds);
  // Also set dir mtime so empty-dir code paths (covered in other tests) line up.
  utimesSync(dir, mtimeSeconds, mtimeSeconds);
}

describe('sweepProjectCap', () => {
  it('keeps the maxProjects most-recent project dirs and removes the rest', () => {
    const home = mkdtempSync(join(tmpdir(), 'mma-projcap-'));
    const root = join(home, '.multi-model', 'context-blocks');
    mkdirSync(root, { recursive: true });
    try {
      mkProject(root, 'aaa1', 1_000_000); // oldest
      mkProject(root, 'aaa2', 1_000_001);
      mkProject(root, 'aaa3', 1_000_002);
      mkProject(root, 'aaa4', 1_000_003);
      mkProject(root, 'aaa5', 1_000_004); // newest

      sweepProjectCap(root, 3);

      const remaining = readdirSync(root).sort();
      expect(remaining).toEqual(['aaa3', 'aaa4', 'aaa5']);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('is a no-op when count is at or below cap', () => {
    const home = mkdtempSync(join(tmpdir(), 'mma-projcap-'));
    const root = join(home, '.multi-model', 'context-blocks');
    mkdirSync(root, { recursive: true });
    try {
      mkProject(root, 'aaa1', 1_000_000);
      mkProject(root, 'aaa2', 1_000_001);
      sweepProjectCap(root, 5);
      const remaining = readdirSync(root).sort();
      expect(remaining).toEqual(['aaa1', 'aaa2']);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('protectedHashes are never evicted even when ranked below cap by mtime', () => {
    const home = mkdtempSync(join(tmpdir(), 'mma-projcap-'));
    const root = join(home, '.multi-model', 'context-blocks');
    mkdirSync(root, { recursive: true });
    try {
      mkProject(root, 'old1', 1_000_000); // oldest — would be dropped without protection
      mkProject(root, 'old2', 1_000_001);
      mkProject(root, 'new1', 1_000_002);
      mkProject(root, 'new2', 1_000_003);
      mkProject(root, 'new3', 1_000_004); // newest

      // Cap of 3, but old1 is active — it must survive even though its
      // mtime ranks it 5th out of 5.
      const result = sweepProjectCap(root, 3, new Set(['old1']));

      const remaining = readdirSync(root).sort();
      expect(remaining).toContain('old1');       // protected — kept
      expect(remaining).toContain('new3');       // newest — kept
      expect(remaining).toContain('new2');       // 2nd-newest fills the remaining slot
      expect(remaining).not.toContain('old2');   // unprotected + oldest — evicted
      expect(remaining).not.toContain('new1');   // unprotected, displaced by old1's slot
      expect(result).toEqual({ kept: 3, evicted: 2 });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('protected count exceeding cap keeps all protected dirs', () => {
    const home = mkdtempSync(join(tmpdir(), 'mma-projcap-'));
    const root = join(home, '.multi-model', 'context-blocks');
    mkdirSync(root, { recursive: true });
    try {
      mkProject(root, 'p1', 1_000_000);
      mkProject(root, 'p2', 1_000_001);
      mkProject(root, 'p3', 1_000_002);
      mkProject(root, 'p4', 1_000_003);
      mkProject(root, 'unp1', 1_000_004);
      mkProject(root, 'unp2', 1_000_005);

      // Cap of 2 but 4 protected → keep all 4 protected, drop the 2 unprotected.
      const result = sweepProjectCap(root, 2, new Set(['p1', 'p2', 'p3', 'p4']));

      const remaining = readdirSync(root).sort();
      expect(remaining).toEqual(['p1', 'p2', 'p3', 'p4']);
      expect(result).toEqual({ kept: 4, evicted: 2 });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
