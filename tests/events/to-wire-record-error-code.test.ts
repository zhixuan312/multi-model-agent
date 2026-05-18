import { describe, it, expect } from 'vitest';
import { toWireRecord } from '../../packages/core/src/events/to-wire-record.js';
import { TaskEnvelopeStore } from '../../packages/core/src/events/task-envelope.js';

function baseOpts() {
  return {
    toolMode: 'full' as const,
    verifyCommandPresent: false, // still required by toWireRecord signature until Task 14 removes it
    implementerModel: 'claude-haiku-4-5',
    implementerTier: 'standard' as const,
    mainModelFamily: 'claude',
  };
}

function failedEnvelopeWithCode(code: 'review_diff_rejected' | 'review_quality_findings_unresolved' | 'review_spec_rejected_terminal') {
  const store = TaskEnvelopeStore.create({
    taskId: 't1', batchId: 'b1', taskIndex: 0,
    route: 'delegate', agentType: 'standard',
    client: 'claude-code', mainModel: 'claude-opus-4-7', cwd: '/tmp',
    reviewPolicy: 'full',
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
  store.seal({ status: 'failed', stopReason: 'incomplete', errorCode: code, realFilesChanged: [] });
  return store.snapshot();
}

describe('toWireRecord errorCode preservation', () => {
  it('emits errorCode=review_diff_rejected when envelope has it', () => {
    const wire = toWireRecord(failedEnvelopeWithCode('review_diff_rejected'), baseOpts());
    expect(wire.terminalStatus).toBe('error');
    expect(wire.errorCode).toBe('review_diff_rejected');
  });

  it('emits errorCode=review_quality_findings_unresolved', () => {
    const wire = toWireRecord(failedEnvelopeWithCode('review_quality_findings_unresolved'), baseOpts());
    expect(wire.errorCode).toBe('review_quality_findings_unresolved');
  });

  it('emits errorCode=review_spec_rejected_terminal', () => {
    const wire = toWireRecord(failedEnvelopeWithCode('review_spec_rejected_terminal'), baseOpts());
    expect(wire.errorCode).toBe('review_spec_rejected_terminal');
  });

  it('emits errorCode=null when terminalStatus is ok', () => {
    const store = TaskEnvelopeStore.create({
      taskId: 't1', batchId: 'b1', taskIndex: 0,
      route: 'delegate', agentType: 'standard',
      client: 'claude-code', mainModel: 'claude-opus-4-7', cwd: '/tmp',
      reviewPolicy: 'full',
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
    const wire = toWireRecord(store.snapshot(), baseOpts());
    expect(wire.terminalStatus).toBe('ok');
    expect(wire.errorCode).toBeNull();
  });
});
