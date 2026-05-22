import { applyParallelSafetySuffixIfNeeded } from '../../packages/core/src/lifecycle/task-runner.js';

describe('applyParallelSafetySuffixIfNeeded', () => {
  const tasks = [{ prompt: 'do A' }, { prompt: 'do B', testCommand: 'npm test' }];

  it('appends the suffix when concurrent', () => {
    const out = applyParallelSafetySuffixIfNeeded(tasks, true);
    expect(out[0]!.prompt).toContain('running in parallel');
    expect(out[1]!.prompt).toContain('To verify your work, run: `npm test`');
  });

  it('returns clones unchanged when not concurrent', () => {
    const out = applyParallelSafetySuffixIfNeeded(tasks, false);
    expect(out[0]!.prompt).toBe('do A');
    expect(out).not.toBe(tasks);
  });
});
