import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crossCheckFilesWritten } from '../../packages/core/src/lifecycle/handlers/files-written-cross-check.js';

/**
 * A4b §2b — terminal cross-check + writes_unverifiable downgrade.
 *
 * Given the post-§2a filtered `filesWritten` array, this handler:
 *   1. stat()s each path against taskSpec.cwd; moves missing entries to
 *      a new `filesWrittenMissing` array on the result envelope.
 *   2. Downgrades workerStatus=done → error: writes_unverifiable when
 *      filesWritten.length === 0 AND worker said `done` AND toolsMode
 *      was `full` (write-capable).
 *   3. Leaves no_op / readonly / mixed cases alone.
 */
describe('A4b.2 crossCheckFilesWritten', () => {
  it('downgrades done-with-no-verifiable-writes to writes_unverifiable error', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mma-xc-'));
    try {
      const result = crossCheckFilesWritten({
        cwd,
        filesWritten: [],
        workerSelfAssessment: 'done',
        toolsMode: 'full',
        autoCommit: false,
      });
      expect(result.workerStatus).toBe('error');
      expect(result.errorCode).toBe('writes_unverifiable');
      expect(result.filesWritten).toEqual([]);
      expect(result.filesWrittenMissing).toEqual([]);
      expect(result.errorMessage).toContain('no verifiable file artifacts');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('does NOT downgrade when worker self-assessment is no_op', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mma-xc-'));
    try {
      const result = crossCheckFilesWritten({
        cwd,
        filesWritten: [],
        workerSelfAssessment: 'no_op',
        toolsMode: 'full',
        autoCommit: false,
      });
      expect(result.workerStatus).toBeUndefined();
      expect(result.errorCode).toBeUndefined();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('does NOT downgrade when toolsMode is readonly (no writes expected)', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mma-xc-'));
    try {
      const result = crossCheckFilesWritten({
        cwd,
        filesWritten: [],
        workerSelfAssessment: 'done',
        toolsMode: 'readonly',
        autoCommit: false,
      });
      expect(result.workerStatus).toBeUndefined();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('moves nonexistent paths from filesWritten to filesWrittenMissing', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mma-xc-'));
    mkdirSync(join(cwd, 'src'), { recursive: true });
    writeFileSync(join(cwd, 'src', 'real.ts'), 'export {};');
    try {
      const result = crossCheckFilesWritten({
        cwd,
        filesWritten: ['src/real.ts', 'src/fake.ts'],
        workerSelfAssessment: 'done',
        toolsMode: 'full',
        autoCommit: false,
      });
      expect(result.filesWritten).toEqual(['src/real.ts']);
      expect(result.filesWrittenMissing).toEqual(['src/fake.ts']);
      // at least one real file → no downgrade
      expect(result.workerStatus).toBeUndefined();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('absolute paths are categorized as missing (sandbox-escape defense-in-depth)', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mma-xc-'));
    try {
      // path-validity filter at A4b.1 should already reject absolutes,
      // but cross-check defends in case one slips through.
      const result = crossCheckFilesWritten({
        cwd,
        filesWritten: ['/etc/passwd'],
        workerSelfAssessment: 'done',
        toolsMode: 'full',
        autoCommit: false,
      });
      expect(result.filesWritten).toEqual([]);
      expect(result.filesWrittenMissing).toEqual(['/etc/passwd']);
      expect(result.workerStatus).toBe('error'); // no real writes left
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('all real paths → no downgrade, filesWrittenMissing empty', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mma-xc-'));
    mkdirSync(join(cwd, 'src'), { recursive: true });
    writeFileSync(join(cwd, 'src', 'a.ts'), 'a');
    writeFileSync(join(cwd, 'src', 'b.ts'), 'b');
    try {
      const result = crossCheckFilesWritten({
        cwd,
        filesWritten: ['src/a.ts', 'src/b.ts'],
        workerSelfAssessment: 'done',
        toolsMode: 'full',
        autoCommit: false,
      });
      expect(result.filesWritten.sort()).toEqual(['src/a.ts', 'src/b.ts']);
      expect(result.filesWrittenMissing).toEqual([]);
      expect(result.workerStatus).toBeUndefined();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('toolsMode=none + done + 0 writes → no downgrade (none-mode workers cant write)', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mma-xc-'));
    try {
      const result = crossCheckFilesWritten({
        cwd,
        filesWritten: [],
        workerSelfAssessment: 'done',
        toolsMode: 'none',
        autoCommit: false,
      });
      expect(result.workerStatus).toBeUndefined();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
