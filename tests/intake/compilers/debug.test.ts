import { describe, it, expect } from 'vitest';
import { compileDebugTask } from '../../../packages/core/src/intake/compilers/debug.js';

describe('debug compiler', () => {
  it('returns single draft', () => {
    const drafts = compileDebugTask({ problem: 'app crashes' }, 'req');
    expect(drafts).toHaveLength(1);
    expect(drafts[0].source.route).toBe('debug_task');
    expect(drafts[0].prompt).toContain('app crashes');
  });

  it('includes optional context and hypothesis', () => {
    const drafts = compileDebugTask({
      problem: 'bug',
      context: 'file X line 10',
      hypothesis: 'null pointer',
    }, 'req');
    expect(drafts[0].prompt).toContain('file X line 10');
    expect(drafts[0].prompt).toContain('null pointer');
  });

  it('sets filePaths', () => {
    const drafts = compileDebugTask({ problem: 'bug', filePaths: ['src/a.ts'] }, 'req');
    expect(drafts[0].filePaths).toEqual(['src/a.ts']);
  });
});