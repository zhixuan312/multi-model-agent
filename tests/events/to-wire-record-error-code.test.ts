import { describe, it, expect } from 'vitest';
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

function failedEnvelopeWithCode(code: 'sdk_max_turns' | 'codex_error') {
  const store = TaskEnvelopeStore.create({
    taskId: 't1', batchId: 'b1', taskIndex: 0,
    route: 'delegate', agentType: 'standard',
    client: 'claude-code', mainModel: 'claude-opus-4-7', cwd: '/tmp',
    reviewPolicy: 'reviewed',
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
  it('emits errorCode=sdk_max_turns when envelope has it', () => {
    const wire = toWireRecord(failedEnvelopeWithCode('sdk_max_turns'), baseOpts());
    expect(wire.terminalStatus).toBe('error');
    expect(wire.errorCode).toBe('sdk_max_turns');
  });

  it('emits errorCode=codex_error', () => {
    const wire = toWireRecord(failedEnvelopeWithCode('codex_error'), baseOpts());
    expect(wire.errorCode).toBe('codex_error');
  });

  // Regression for the failed-task telemetry-drop bug: the real production
  // producer (buildEnvelopeSnapshot in unified-task.ts) seals a failed task with
  // errorCode=null and structuredError={code:'pipeline_failed'}. 'pipeline_failed'
  // is NOT a member of ErrorCodeSchema, so toWireRecord's final
  // ValidatedTaskCompletedEventSchema.parse() threw for EVERY failed-pipeline
  // task and TelemetryUploader silently swallowed the throw — dropping telemetry
  // for all failures. The pre-existing tests missed it because they always sealed
  // with a valid errorCode, never exercising the structuredError.code fallback.
  it('maps the pipeline_failed sentinel to "other" instead of throwing', () => {
    const base = failedEnvelopeWithCode('sdk_max_turns');
    const prodShaped = {
      ...base,
      errorCode: null,
      structuredError: { code: 'pipeline_failed', message: 'Pipeline completed with failed status' },
    };
    // Must not throw (previously threw inside ValidatedTaskCompletedEventSchema.parse).
    const wire = toWireRecord(prodShaped, baseOpts());
    expect(wire.terminalStatus).toBe('error');
    expect(wire.errorCode).toBe('other');
  });

  it('emits errorCode=null when terminalStatus is ok', () => {
    const store = TaskEnvelopeStore.create({
      taskId: 't1', batchId: 'b1', taskIndex: 0,
      route: 'delegate', agentType: 'standard',
      client: 'claude-code', mainModel: 'claude-opus-4-7', cwd: '/tmp',
      reviewPolicy: 'reviewed',
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
