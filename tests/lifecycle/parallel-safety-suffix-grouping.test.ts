import { describe, it, expect } from 'vitest';
import { applyParallelSafetySuffixIfNeeded } from '../../packages/core/src/lifecycle/task-runner.js';
import type { TaskSpec } from '../../packages/core/src/types.js';

function task(prompt: string): TaskSpec { return { prompt, cwd: '/tmp' }; }

describe('PARALLEL_SAFETY_SUFFIX gating', () => {
  it('does NOT append suffix when batchGroupCount is 1', () => {
    const tasks = [task('a'), task('b'), task('c')];
    const out = applyParallelSafetySuffixIfNeeded(tasks, { batchGroupCount: 1 });
    out.forEach((t) => expect(t.prompt).not.toContain('You are running in parallel'));
  });

  it('does NOT append suffix when batchGroupCount is undefined', () => {
    const tasks = [task('a'), task('b')];
    const out = applyParallelSafetySuffixIfNeeded(tasks, {});
    out.forEach((t) => expect(t.prompt).not.toContain('You are running in parallel'));
  });

  it('appends suffix when batchGroupCount > 1', () => {
    const tasks = [task('a'), task('b')];
    const out = applyParallelSafetySuffixIfNeeded(tasks, { batchGroupCount: 2 });
    out.forEach((t) => expect(t.prompt).toContain('You are running in parallel'));
  });
});
