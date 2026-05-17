// tests/events/task-envelope-seal.test.ts
import { describe, it, expect } from 'vitest';
import { TaskEnvelopeStore, SealedEnvelopeError } from '../../packages/core/src/events/task-envelope.js';

const seed = { taskId: 't1', batchId: 'b1', taskIndex: 0, route: 'delegate' as const, agentType: 'standard' as const, client: 'claude-code', mainModel: 'claude-opus-4-7', cwd: '/tmp' };

describe('TaskEnvelopeStore.seal', () => {
  it('sets status, terminalAt, structuredError', () => {
    const s = TaskEnvelopeStore.create(seed);
    s.seal({ status: 'done', stopReason: 'normal', realFilesChanged: ['/a'] });
    const snap = s.snapshot();
    expect(snap.status).toBe('done');
    expect(snap.terminalAt).not.toBeNull();
    expect(snap.realFilesChanged).toEqual(['/a']);
  });

  it('throws on any mutation after seal', () => {
    const s = TaskEnvelopeStore.create(seed);
    s.seal({ status: 'done', stopReason: 'ok', realFilesChanged: [] });
    expect(() => s.startStage('implementing', { model: 'm', tier: 'standard' })).toThrow(SealedEnvelopeError);
    expect(() => s.recordToolCall({ stage: 's', tool: 't' })).toThrow(SealedEnvelopeError);
    expect(() => s.seal({ status: 'done', stopReason: 'x', realFilesChanged: [] })).toThrow(SealedEnvelopeError);
  });

  it('recordHeartbeat is a silent no-op after seal (regression: periodic timer can race past seal)', () => {
    // The heartbeat ActivityTracker fires on a 5s interval and may tick once
    // more between seal() and timer disposal. If recordHeartbeat threw, the
    // throw would propagate as runner_crash at terminal — sealing the task
    // as failed even though the worker succeeded. Heartbeats are advisory,
    // so they no-op after seal instead of throwing.
    const s = TaskEnvelopeStore.create(seed);
    s.seal({ status: 'done', stopReason: 'normal', realFilesChanged: [] });
    expect(() => s.recordHeartbeat({ stallIdleMs: 0 })).not.toThrow();
  });

  it('isSealed reports true after seal', () => {
    const s = TaskEnvelopeStore.create(seed);
    expect(s.isSealed()).toBe(false);
    s.seal({ status: 'failed', stopReason: 'err', realFilesChanged: [] });
    expect(s.isSealed()).toBe(true);
  });
});
