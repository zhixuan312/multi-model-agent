import { describe, it, expect } from 'vitest';
import { TaskEnvelopeStore } from '../fixtures/task-envelope-store.js';

describe('TaskEnvelope reviewPolicy + errorCode honesty', () => {
  const baseSeed = {
    taskId: 't1', batchId: 'b1', taskIndex: 0,
    route: 'delegate' as const, agentType: 'standard' as const,
    client: 'claude-code', mainModel: 'claude-opus-4-7', cwd: '/tmp',
  };

  it.each(['reviewed', 'none'] as const)('stores reviewPolicy=%s on construction', (policy) => {
    const store = TaskEnvelopeStore.create({ ...baseSeed, reviewPolicy: policy });
    expect(store.snapshot().reviewPolicy).toBe(policy);
  });

  it('throws when reviewPolicy is missing at construction (lifecycle-init bug)', () => {
    expect(() => TaskEnvelopeStore.create(baseSeed as any))
      .toThrow(/reviewPolicy/i);
  });

  it('errorCode is null by default and stays null after seal without errorCode', () => {
    const store = TaskEnvelopeStore.create({ ...baseSeed, reviewPolicy: 'reviewed' });
    expect(store.snapshot().errorCode).toBeNull();
    store.seal({ status: 'done', stopReason: null, realFilesChanged: [] });
    expect(store.snapshot().errorCode).toBeNull();
  });

  it('seal preserves errorCode when supplied', () => {
    const store = TaskEnvelopeStore.create({ ...baseSeed, reviewPolicy: 'reviewed' });
    store.seal({ status: 'failed', stopReason: 'incomplete', structuredError: null, errorCode: 'sdk_max_turns', realFilesChanged: [] });
    expect(store.snapshot().errorCode).toBe('sdk_max_turns');
  });
});
