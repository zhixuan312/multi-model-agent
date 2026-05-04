import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileArtifactExists } from '../../packages/core/src/bounded-execution/file-artifact-check.js';

describe('fileArtifactExists', () => {
  it('returns true for existing non-empty file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fac-'));
    const p = join(dir, 'a.txt');
    writeFileSync(p, 'hi');
    expect(fileArtifactExists(p)).toBe(true);
  });
  it('returns false for missing file', () => {
    expect(fileArtifactExists('/nonexistent/path/x')).toBe(false);
  });
  it('returns false for empty file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fac-'));
    const p = join(dir, 'a.txt');
    writeFileSync(p, '');
    expect(fileArtifactExists(p)).toBe(false);
  });
});
