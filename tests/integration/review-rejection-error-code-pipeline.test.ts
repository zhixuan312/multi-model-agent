import { describe, it, expect } from 'bun:test';
import { TaskEnvelopeStore } from '../../packages/core/src/events/task-envelope.js';
import { toWireRecord } from '../../packages/core/src/events/to-wire-record.js';
// Import enrichRuntimeResult + recordTaskCompletedHandler from the lifecycle module:
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

describe('review-rejection → wire errorCode end-to-end', () => {
  it('quality review rejection lands review_quality_findings_unresolved on wire', async () => {
    const store = TaskEnvelopeStore.create({
      taskId: 't1', batchId: 'b1', taskIndex: 0,
      route: 'delegate', agentType: 'standard',
      client: 'claude-code', mainModel: 'claude-opus-4-7', cwd: '/tmp',
      reviewPolicy: 'quality_only',
    });

    // Construct a minimal lifecycle state that triggers the reviewRejected branch
    // in enrichRuntimeResult, then seal via recordTaskCompletedHandler.
    const mockProvider = {
      config: { model: 'claude-opus-4-7' },
    };

    const state: any = {
      reviewPolicy: 'quality_only',
      reviewVerdict: 'changes_required',
      reviewSubResults: [{ name: 'quality', verdict: 'changes_required' }],
      reworkApplied: false,
      lastRunResult: {
        status: 'incomplete',
        workerStatus: 'done',
        turns: 1,
        filesWritten: [],
        terminationReason: { cause: 'incomplete', turnsUsed: 1, hasFileArtifacts: false, usedShell: false, workerSelfAssessment: 'done', wasPromoted: false },
        structuredError: null,
      },
      executionContext: {
        envelope: store,
        assignedTier: 'standard',
        implementerProvider: mockProvider,
        providers: {
          standard: mockProvider,
          complex: mockProvider,
        },
        implementerToolMode: 'full',
      },
      // 4.7.8: deriveCompletion reads gates.implement.outcome. Without it
      // the seal falls back to workerStatus and produces a wire record
      // that fails R1 (ok + errorCode). Review rejection means no commit
      // stage fires (commit gate stays unset), which deriveCompletion
      // correctly translates to completed=false.
      gates: { implement: { outcome: 'advance' }, review: { outcome: 'advance', payload: { verdict: 'changes_required', findings: [{ source: 'reviewer', claim: 'rejected' }] } } },      taskCompletedRecorded: false,
    };

    // Add a synthetic implementing stage so wire-schema R2.1 passes (empty
    // stages only allowed for brief_too_vague|error envelopes).
    store.startStage('implementing', { model: 'claude-haiku-4-5', tier: 'standard', round: 1 });
    store.completeStage('implementing', 1, {
      outcome: 'advance',
      durationMs: 100,
      costUSD: 0.001,
      inputTokens: 10,
      outputTokens: 5,
      cachedReadTokens: 0,
      cachedNonReadTokens: 0,
      turnsUsed: 1,
      toolCallCount: 0,
      filesReadCount: 0,
      filesWrittenCount: 0,
    });

    enrichRuntimeResult(state);
    await recordTaskCompletedHandler(state);

    const wire = toWireRecord(store.snapshot(), baseOpts());
    expect(wire.terminalStatus).toBe('error');
    expect(wire.workerStatus).toBe('failed');
    expect(wire.errorCode).toBe('review_quality_findings_unresolved');
  });

  it('spec review rejection lands review_spec_rejected_terminal on wire', async () => {
    const store = TaskEnvelopeStore.create({
      taskId: 't2', batchId: 'b1', taskIndex: 0,
      route: 'audit', agentType: 'standard',
      client: 'claude-code', mainModel: 'claude-opus-4-7', cwd: '/tmp',
      reviewPolicy: 'diff_only',
    });

    const mockProvider = {
      config: { model: 'claude-opus-4-7' },
    };

    const state: any = {
      reviewPolicy: 'diff_only',
      reviewVerdict: 'changes_required',
      reviewSubResults: [{ name: 'spec', verdict: 'changes_required' }],
      reworkApplied: false,
      lastRunResult: {
        status: 'incomplete', workerStatus: 'done', turns: 1, filesWritten: [],
        terminationReason: { cause: 'incomplete', turnsUsed: 1, hasFileArtifacts: false, usedShell: false, workerSelfAssessment: 'done', wasPromoted: false },
        structuredError: null,
      },
      executionContext: {
        envelope: store,
        assignedTier: 'standard',
        implementerProvider: mockProvider,
        providers: {
          standard: mockProvider,
          complex: mockProvider,
        },
        implementerToolMode: 'full',
      },
      // 4.7.8: deriveCompletion reads gates.implement.outcome. Without it
      // the seal falls back to workerStatus and produces a wire record
      // that fails R1 (ok + errorCode). Review rejection means no commit
      // stage fires (commit gate stays unset), which deriveCompletion
      // correctly translates to completed=false.
      gates: { implement: { outcome: 'advance' }, review: { outcome: 'advance', payload: { verdict: 'changes_required', findings: [{ source: 'reviewer', claim: 'rejected' }] } } },      taskCompletedRecorded: false,
    };

    // Add a synthetic implementing stage so wire-schema R2.1 passes (empty
    // stages only allowed for brief_too_vague|error envelopes).
    store.startStage('implementing', { model: 'claude-haiku-4-5', tier: 'standard', round: 1 });
    store.completeStage('implementing', 1, {
      outcome: 'advance',
      durationMs: 100,
      costUSD: 0.001,
      inputTokens: 10,
      outputTokens: 5,
      cachedReadTokens: 0,
      cachedNonReadTokens: 0,
      turnsUsed: 1,
      toolCallCount: 0,
      filesReadCount: 0,
      filesWrittenCount: 0,
    });

    enrichRuntimeResult(state);
    await recordTaskCompletedHandler(state);

    const wire = toWireRecord(store.snapshot(), baseOpts());
    expect(wire.errorCode).toBe('review_spec_rejected_terminal');
  });
});
