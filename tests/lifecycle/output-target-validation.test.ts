import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkOutputTargets } from '@zhixuan92/multi-model-agent-core/bounded-execution/file-artifact-check';

vi.mock('fs', () => ({
  existsSync: vi.fn(),
}));

import { existsSync } from 'fs';

describe('output-target validation (post-task helper contract)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns missing paths when targets are absent', () => {
    (existsSync as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    const missing = checkOutputTargets(['/project/src/present.ts', '/project/src/absent.ts']);
    expect(missing).toEqual(['/project/src/absent.ts']);
  });

  it('returns empty array when all targets exist', () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    expect(checkOutputTargets(['/project/src/a.ts', '/project/src/b.ts'])).toEqual([]);
  });

  it('returns empty array on empty input', () => {
    expect(checkOutputTargets([])).toEqual([]);
  });
});
