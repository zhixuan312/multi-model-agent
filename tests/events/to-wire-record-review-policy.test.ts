import { describe, it, expect } from 'bun:test';
import { toWireRecord } from '../../packages/core/src/events/to-wire-record.js';
import { TaskEnvelopeStore } from '../../packages/core/src/events/task-envelope.js';

function baseOpts() {
  return {
    toolMode: 'full' as const,
    implementerModel: 'claude-haiku-4-5',
    implementerTier: 'standard' as const,
    mainModelFamily: 'claude',
  };
}

function envelopeWithPolicy(policy: 'full' | 'quality_only' | 'diff_only' | 'none') {
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

describe('toWireRecord reviewPolicy honesty', () => {
  it('emits reviewPolicy="full" when envelope has full', () => {
    const wire = toWireRecord(envelopeWithPolicy('full'), baseOpts());
    expect(wire.reviewPolicy).toBe('full');
  });

  it('emits reviewPolicy="quality_only"', () => {
    const wire = toWireRecord(envelopeWithPolicy('quality_only'), baseOpts());
    expect(wire.reviewPolicy).toBe('quality_only');
  });

  it('emits reviewPolicy="diff_only"', () => {
    const wire = toWireRecord(envelopeWithPolicy('diff_only'), baseOpts());
    expect(wire.reviewPolicy).toBe('diff_only');
  });

  it('emits reviewPolicy="none"', () => {
    const wire = toWireRecord(envelopeWithPolicy('none'), baseOpts());
    expect(wire.reviewPolicy).toBe('none');
  });

  it('opts.reviewPolicy is no longer in the opts signature', () => {
    // This is a type-level assertion — if it compiles, the signature dropped reviewPolicy.
    // @ts-expect-error reviewPolicy must not be in opts after Task 2
    toWireRecord(envelopeWithPolicy('none'), { ...baseOpts(), reviewPolicy: 'full' });
  });
});
