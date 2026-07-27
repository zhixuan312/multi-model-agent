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

// R9 regression: a `review` stage is legitimate on EVERY reviewable route (every route except
// orchestrate / register-context-block). The allowlist form omitted `plan`/`spec`, so their
// completed tasks' telemetry was rejected on upload ("R9: review stage only allowed on reviewed
// routes") — the reported bug. No test covered plan/spec with a review stage, which is why it shipped.
function envelopeWithReviewStage(route: string, reviewPolicy: 'reviewed' | 'none' = 'reviewed') {
  const store = TaskEnvelopeStore.create({
    taskId: 't1', batchId: 'b1', taskIndex: 0,
    route: route as never, agentType: 'complex',
    client: 'claude-code', mainModel: 'claude-opus-4-7', cwd: '/tmp',
    reviewPolicy,
  });
  store.startStage('implementing', { model: 'm', tier: 'complex', round: 1 });
  store.completeStage('implementing', 1, {
    outcome: 'advance', durationMs: 100, costUSD: 0.01, inputTokens: 100, outputTokens: 50,
    cachedReadTokens: 0, cachedNonReadTokens: 0, turnsUsed: 1, toolCallCount: 0, filesReadCount: 0, filesWrittenCount: 1,
  });
  store.startStage('reviewing', { model: 'm', tier: 'complex', round: 1 });
  store.completeStage('reviewing', 1, {
    outcome: 'advance', durationMs: 50, costUSD: 0.005, verdict: 'approved', inputTokens: 50, outputTokens: 25,
    cachedReadTokens: 0, cachedNonReadTokens: 0, turnsUsed: 1, toolCallCount: 0, filesReadCount: 0, filesWrittenCount: 0,
  });
  store.seal({ status: 'done', stopReason: 'normal', realFilesChanged: [] });
  return store.snapshot();
}

describe('toWireRecord R9 — review stage allowed on every reviewable route', () => {
  for (const route of ['plan', 'spec', 'delegate', 'research', 'journal-recall', 'execute-plan']) {
    it(`accepts a review stage on the ${route} route`, () => {
      const wire = toWireRecord(envelopeWithReviewStage(route), baseOpts());
      expect(wire.route).toBe(route);
      expect(wire.stages.some((s) => s.name === 'review')).toBe(true);
    });
  }

  it('rejects a review stage on orchestrate (the one never-reviewed pipeline route) — R9', () => {
    expect(() => toWireRecord(envelopeWithReviewStage('orchestrate', 'none'), baseOpts())).toThrow(/R9/);
  });
});
