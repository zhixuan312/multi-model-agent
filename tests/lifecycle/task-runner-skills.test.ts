import { resolveSkillsForTask } from '../../packages/core/src/lifecycle/task-runner.js';

describe('resolveSkillsForTask', () => {
  it('returns undefined when the task has no skills', async () => {
    const r = await resolveSkillsForTask({ task: { prompt: 'x' }, client: 'claude-code', batchId: 'b', taskIndex: 0 });
    expect(r.bundle).toBeUndefined();
    expect(r.failure).toBeUndefined();
  });

  it('returns a per-task failure (not a throw) for an unsupported client', async () => {
    const r = await resolveSkillsForTask({
      task: { prompt: 'x', skills: ['a'] }, client: 'cursor', batchId: 'b', taskIndex: 0,
    });
    expect(r.bundle).toBeUndefined();
    expect(r.failure?.status).toBe('error');
    expect(r.failure?.errorCode).toBe('skill_store_unsupported');
    expect(r.failure?.workerStatus).toBe('failed');
  });
});
