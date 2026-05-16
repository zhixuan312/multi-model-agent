import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkOutputTargets } from '@zhixuan92/multi-model-agent-core/bounded-execution/file-artifact-check';

vi.mock('fs', () => ({
  existsSync: vi.fn(),
}));

import { existsSync } from 'fs';

describe('checkOutputTargets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty array when all targets exist', () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const missing = checkOutputTargets(['/project/src/new-file.ts']);
    expect(missing).toEqual([]);
  });

  it('returns the missing paths when some are absent', () => {
    (existsSync as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    const missing = checkOutputTargets(['/project/src/a.ts', '/project/src/b.ts']);
    expect(missing).toEqual(['/project/src/b.ts']);
  });

  it('returns empty array on empty input', () => {
    expect(checkOutputTargets([])).toEqual([]);
  });
});
