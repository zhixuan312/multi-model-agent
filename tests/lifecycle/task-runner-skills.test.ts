import { resolveSkillsForTask, runTaskViaDispatcher } from '../../packages/core/src/lifecycle/task-runner.js';
import { TaskEnvelopeStore } from '../../packages/core/src/events/task-envelope.js';

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

describe('runTaskViaDispatcher — skill resolution failure seals the envelope', () => {
  it('seals the per-task envelope to terminal failed (so GET /batch is not stuck "running")', async () => {
    const env = TaskEnvelopeStore.create({
      taskId: 't:0', batchId: 'b', taskIndex: 0, route: 'delegate', agentType: 'standard',
      client: 'cursor', mainModel: 'claude-opus-4-7', cwd: '/tmp', reviewPolicy: 'none',
    });
    expect(env.snapshot().status).toBe('running');

    // client 'cursor' has no skills store → resolution fails before the
    // lifecycle runs; the short-circuit must still seal the envelope.
    const result = await runTaskViaDispatcher({
      task: { prompt: 'x', skills: ['whatever'] },
      client: 'cursor',
      taskIndex: 0,
      batchId: 'b',
      envelope: env,
      resolved: {} as never,
      config: {} as never,
    } as never);

    expect(result.errorCode).toBe('skill_store_unsupported');
    const snap = env.snapshot();
    expect(snap.status).toBe('failed');
    expect(snap.terminalAt).not.toBeNull();
    // Precise code on structuredError (surfaces on results[i].error.code)...
    expect(snap.structuredError?.code).toBe('skill_store_unsupported');
    // ...but the enum-validated errorCode stays wire-safe so the telemetry
    // record passes Zod validation on upload (regression guard for the
    // telemetry_upload_error caught live on 4.9.0).
    expect(snap.errorCode).toBe('other');
  });
});
