import { describe, it, expect } from 'bun:test';
import { TaskEnvelopeStore } from '../../packages/core/src/events/task-envelope.js';

describe('TaskEnvelope reviewPolicy + errorCode honesty', () => {
  const baseSeed = {
    taskId: 't1', batchId: 'b1', taskIndex: 0,
    route: 'delegate' as const, agentType: 'standard' as const,
    client: 'claude-code', mainModel: 'claude-opus-4-7', cwd: '/tmp',
  };

  it('stores per-task reviewPolicy on construction (full)', () => {
    const store = TaskEnvelopeStore.create({ ...baseSeed, reviewPolicy: 'full' });
    expect(store.snapshot().reviewPolicy).toBe('full');
  });

  it('stores per-task reviewPolicy on construction (quality_only)', () => {
    const store = TaskEnvelopeStore.create({ ...baseSeed, reviewPolicy: 'quality_only' });
    expect(store.snapshot().reviewPolicy).toBe('quality_only');
  });

  it('stores per-task reviewPolicy on construction (diff_only)', () => {
    const store = TaskEnvelopeStore.create({ ...baseSeed, reviewPolicy: 'diff_only' });
    expect(store.snapshot().reviewPolicy).toBe('diff_only');
  });

  it('stores per-task reviewPolicy on construction (none)', () => {
    const store = TaskEnvelopeStore.create({ ...baseSeed, reviewPolicy: 'none' });
    expect(store.snapshot().reviewPolicy).toBe('none');
  });

  it('throws when reviewPolicy is missing at construction (lifecycle-init bug)', () => {
    expect(() => TaskEnvelopeStore.create(baseSeed as any))
      .toThrow(/reviewPolicy/i);
  });

  it('errorCode is null by default and stays null after seal without errorCode', () => {
    const store = TaskEnvelopeStore.create({ ...baseSeed, reviewPolicy: 'full' });
    expect(store.snapshot().errorCode).toBeNull();
    store.seal({ status: 'done', stopReason: null, realFilesChanged: [] });
    expect(store.snapshot().errorCode).toBeNull();
  });

  it('seal preserves errorCode when supplied', () => {
    const store = TaskEnvelopeStore.create({ ...baseSeed, reviewPolicy: 'full' });
    store.seal({ status: 'failed', stopReason: 'incomplete', structuredError: null, errorCode: 'review_quality_findings_unresolved', realFilesChanged: [] });
    expect(store.snapshot().errorCode).toBe('review_quality_findings_unresolved');
  });
});
