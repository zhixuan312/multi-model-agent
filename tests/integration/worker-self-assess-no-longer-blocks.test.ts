import { describe, it, expect } from 'vitest';
import { TaskEnvelopeStore } from '../../packages/core/src/events/task-envelope.js';
import { toWireRecord } from '../../packages/core/src/events/to-wire-record.js';
import { enrichRuntimeResult } from '../../packages/core/src/lifecycle/handlers/enrich-runtime-result.js';
import { recordTaskCompletedHandler } from '../../packages/core/src/lifecycle/handlers/terminal-handlers.js';

function baseOpts() {
  return {
    toolMode: 'full' as const,
    implementerModel: 'claude-haiku-4-5',
    implementerTier: 'standard' as const,
    mainModelFamily: 'claude',
  };
}

describe('worker self-assess "failed" no longer blocks the wire record', () => {
  it('review approved + commit landed → wire terminal_status=ok despite worker failed', async () => {
    const store = TaskEnvelopeStore.create({
      taskId: 't1', batchId: 'b1', taskIndex: 0,
      route: 'delegate', agentType: 'standard',
      client: 'claude-code', mainModel: 'claude-opus-4-7', cwd: '/tmp',
      reviewPolicy: 'full',
    });

    store.startStage('implementing', { model: 'claude-haiku-4-5', tier: 'standard', round: 1 });
    store.completeStage('implementing', 1, {
      outcome: 'advance', durationMs: 100, costUSD: 0.001,
      inputTokens: 10, outputTokens: 5, cachedReadTokens: 0, cachedNonReadTokens: 0,
      turnsUsed: 1, toolCallCount: 0, filesReadCount: 0, filesWrittenCount: 0,
    });

    const state: any = {
      route: 'delegate',
      reviewPolicy: 'full',
      reviewVerdict: 'approved',
      reworkApplied: undefined,
      lastRunResult: {
        status: 'ok',
        workerStatus: 'failed',  // ← worker MISREPORTS
        terminationReason: { cause: 'normal', turnsUsed: 1, hasFileArtifacts: true, usedShell: false, workerSelfAssessment: 'failed', wasPromoted: false },
        structuredError: null,
        criteriaSucceeded: [],
      },
      gates: {
        implement: { outcome: 'advance' },
        review: { outcome: 'advance', payload: { verdict: 'approved', findings: [] } },
        commit: { payload: { kind: 'committed', commitSha: 'abc1234', commitMessage: 's', filesChanged: ['x.ts'] } },
      },      executionContext: {
        envelope: store,
        assignedTier: 'standard',
        implementerProvider: { config: { model: 'claude-haiku-4-5' } },
        providers: { standard: { config: { model: 'claude-haiku-4-5' } }, complex: { config: { model: 'claude-opus-4-7' } } },
      },
      taskCompletedRecorded: false,
    };

    enrichRuntimeResult(state);
    await recordTaskCompletedHandler(state);

    const wire = toWireRecord(store.snapshot(), baseOpts());
    expect(wire.terminalStatus).toBe('ok');
    expect(wire.workerStatus).toBe('done');
    expect(wire.errorCode).toBeNull();
  });

  it('reviewer rejection + no rework → still terminal_status=error (legit failure preserved)', async () => {
    const store = TaskEnvelopeStore.create({
      taskId: 't2', batchId: 'b1', taskIndex: 0,
      route: 'delegate', agentType: 'standard',
      client: 'claude-code', mainModel: 'claude-opus-4-7', cwd: '/tmp',
      reviewPolicy: 'full',
    });

    store.startStage('implementing', { model: 'claude-haiku-4-5', tier: 'standard', round: 1 });
    store.completeStage('implementing', 1, {
      outcome: 'advance', durationMs: 100, costUSD: 0.001,
      inputTokens: 10, outputTokens: 5, cachedReadTokens: 0, cachedNonReadTokens: 0,
      turnsUsed: 1, toolCallCount: 0, filesReadCount: 0, filesWrittenCount: 0,
    });

    const state: any = {
      route: 'delegate',
      reviewPolicy: 'full',
      reviewVerdict: 'changes_required',
      reviewSubResults: [{ name: 'quality', verdict: 'changes_required' }],
      reworkApplied: false,
      lastRunResult: {
        status: 'incomplete', workerStatus: 'done',
        terminationReason: { cause: 'incomplete', turnsUsed: 1, hasFileArtifacts: false, usedShell: false, workerSelfAssessment: 'done', wasPromoted: false },
        structuredError: null,
      },
      gates: {
        implement: { outcome: 'advance' },
        review: { outcome: 'advance', payload: { verdict: 'changes_required', findings: [{ source: 'reviewer', claim: 'rejected' }] } },
        commit: { payload: { kind: 'committed', commitSha: 'def', commitMessage: 's', filesChanged: [] } },
      },      executionContext: {
        envelope: store,
        assignedTier: 'standard',
        implementerProvider: { config: { model: 'claude-haiku-4-5' } },
        providers: { standard: { config: { model: 'claude-haiku-4-5' } }, complex: { config: { model: 'claude-opus-4-7' } } },
      },
      taskCompletedRecorded: false,
    };

    enrichRuntimeResult(state);
    await recordTaskCompletedHandler(state);

    const wire = toWireRecord(store.snapshot(), baseOpts());
    expect(wire.terminalStatus).toBe('error');
    expect(wire.errorCode).toBe('review_quality_findings_unresolved');
  });
});
