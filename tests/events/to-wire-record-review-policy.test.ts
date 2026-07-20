import { describe, it, expect } from 'vitest';
import { toWireRecord } from '../../packages/core/src/events/to-wire-record.js';
import { TaskEnvelopeStore } from '../fixtures/task-envelope-store.js';

function baseOpts() {
  return {
    toolMode: 'full' as const,
    implementerModel: 'claude-haiku-4-5',
    implementerTier: 'standard' as const,
    mainModelFamily: 'claude',
  };
}

function envelopeWithPolicy(policy: 'reviewed' | 'none') {
  const store = TaskEnvelopeStore.create({
    taskId: 't1', batchId: 'b1', taskIndex: 0,
    route: 'delegate', agentType: 'standard',
    client: 'claude-code', mainModel: 'claude-opus-4-7', cwd: '/tmp',
    reviewPolicy: policy,
  });
  store.startStage('implementing', { model: 'claude-sonnet-4-6', tier: 'standard' });
  store.completeStage('implementing', 1, {
    outcome: 'advance',
    durationMs: 100,
    costUSD: 0.01,
    turnsUsed: 1,
    inputTokens: 100,
    outputTokens: 50,
  });
  store.seal({ status: 'done', stopReason: null, realFilesChanged: [] });
  return store.snapshot();
}

describe('toWireRecord reviewPolicy (v6: reviewed/none)', () => {
  it('emits reviewPolicy="reviewed" when set', () => {
    const wire = toWireRecord(envelopeWithPolicy('reviewed'), baseOpts());
    expect(wire.reviewPolicy).toBe('reviewed');
  });

  it('emits reviewPolicy="none" when set', () => {
    const wire = toWireRecord(envelopeWithPolicy('none'), baseOpts());
    expect(wire.reviewPolicy).toBe('none');
  });

  it('opts.reviewPolicy is not in the opts signature', () => {
    // @ts-expect-error reviewPolicy must not be in opts
    toWireRecord(envelopeWithPolicy('none'), { ...baseOpts(), reviewPolicy: 'reviewed' });
  });
});
