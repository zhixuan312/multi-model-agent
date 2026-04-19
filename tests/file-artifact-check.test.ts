import { describe, it, expect, vi, beforeEach } from 'vitest';
import { partitionFilePaths, checkOutputTargets } from '@zhixuan92/multi-model-agent-core/file-artifact-check';

vi.mock('fs', () => ({
  existsSync: vi.fn(),
}));

import { existsSync } from 'fs';

describe('partitionFilePaths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('partitions into existing inputs and non-existing output targets', () => {
    (existsSync as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(true)   // src/existing.ts
      .mockReturnValueOnce(false); // src/new-file.ts
    const result = partitionFilePaths(['src/existing.ts', 'src/new-file.ts'], '/project');
    expect(result.outputTargets).toEqual(['/project/src/new-file.ts']);
  });

  it('returns empty outputTargets when all paths exist', () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const result = partitionFilePaths(['src/a.ts', 'src/b.ts'], '/project');
    expect(result.outputTargets).toEqual([]);
  });

  it('returns empty outputTargets when filePaths is undefined', () => {
    const result = partitionFilePaths(undefined, '/project');
    expect(result.outputTargets).toEqual([]);
  });

  it('returns empty outputTargets when filePaths is empty', () => {
    const result = partitionFilePaths([], '/project');
    expect(result.outputTargets).toEqual([]);
  });
});

describe('checkOutputTargets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns false when all targets exist', () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const missing = checkOutputTargets(['/project/src/new-file.ts']);
    expect(missing).toBe(false);
  });

  it('returns true when any target is missing', () => {
    (existsSync as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    const missing = checkOutputTargets(['/project/src/a.ts', '/project/src/b.ts']);
    expect(missing).toBe(true);
  });

  it('returns false for empty targets list', () => {
    const missing = checkOutputTargets([]);
    expect(missing).toBe(false);
  });
});
