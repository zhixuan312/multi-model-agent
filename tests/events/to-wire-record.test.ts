import { describe, it, expect } from 'bun:test';
import { TaskEnvelopeStore } from '../../packages/core/src/events/task-envelope.js';
import { toWireRecord } from '../../packages/core/src/events/to-wire-record.js';
import { ValidatedTaskCompletedEventSchema } from '../../packages/core/src/events/wire-schema.js';

const seed = {
  taskId: 't',
  batchId: 'b',
  taskIndex: 0,
  route: 'delegate' as const,
  agentType: 'standard' as const,
  client: 'claude-code',
  mainModel: 'claude-opus-4-7',
  cwd: '/tmp',
  reviewPolicy: 'full' as const,
};

describe('toWireRecord', () => {
  it('produces an envelope that passes ValidatedTaskCompletedEventSchema', () => {
    const s = TaskEnvelopeStore.create(seed);
    s.startStage('implementing', { model: 'claude-sonnet-4-6', tier: 'standard' });
    s.completeStage('implementing', 1, {
      outcome: 'advance',
      durationMs: 1000,
      costUSD: 0.05,
      turnsUsed: 3,
      inputTokens: 100,
      outputTokens: 50,
    });
    s.seal({ status: 'done', stopReason: 'normal', realFilesChanged: ['/a', '/b'] });
    const wire = toWireRecord(s.snapshot(), {
      toolMode: 'full',
      implementerModel: 'claude-sonnet-4-6',
      implementerTier: 'standard',
      mainModelFamily: 'claude',
    });
    expect(() => ValidatedTaskCompletedEventSchema.parse(wire)).not.toThrow();
    expect(wire.filesWrittenCount).toBe(2);
    expect(wire.totalCostUSD).toBe(0.05);
  });

  // Regression coverage for the 4.7.2-4.7.5 bug: per-stage and top-level
  // mainCostUSD + costDeltaVsMainUSD were emitted as null because the
  // envelope-unification refactor dropped the compute. Restored in 4.7.6.
  // The wire test that would have caught this (v4-envelope.test.ts) was
  // deleted in 5c1d4090; these asserts close that gap.
  it('populates mainCostUSD per stage and at top level when mainModel resolves', () => {
    const s = TaskEnvelopeStore.create(seed); // mainModel: claude-opus-4-7
    s.startStage('implementing', { model: 'claude-haiku-4-5', tier: 'standard' });
    s.completeStage('implementing', 1, {
      outcome: 'advance',
      durationMs: 1000,
      costUSD: 0.07,
      turnsUsed: 1,
      inputTokens: 10_000,
      outputTokens: 1_000,
      cachedReadTokens: 5_000,
      cachedNonReadTokens: 0,
    });
    s.seal({ status: 'done', stopReason: 'normal', realFilesChanged: [] });
    const wire = toWireRecord(s.snapshot(), {
      toolMode: 'full',
      implementerModel: 'claude-haiku-4-5',
      implementerTier: 'standard',
      mainModelFamily: 'claude',
    });
    // claude-opus-4-7 rate card: input $5/M, output $25/M, cachedRead $0.50/M, cachedNonRead $6.25/M
    // mainCost = (10000 * 5 + 1000 * 25 + 5000 * 0.50 + 0 * 6.25) / 1e6 = 0.0775
    expect(wire.mainCostUSD).toBeCloseTo(0.0775, 6);
    expect((wire.stages[0] as { mainCostUSD: number }).mainCostUSD).toBeCloseTo(0.0775, 6);
    // delta = totalCost - mainCost = 0.07 - 0.0775 = -0.0075 (negative = saved)
    expect(wire.costDeltaVsMainUSD).toBeCloseTo(-0.0075, 6);
  });

  it('per-stage mainCostUSD sums to top-level mainCostUSD by construction (priceTokens is linear)', () => {
    const s = TaskEnvelopeStore.create(seed);
    s.startStage('implementing', { model: 'claude-haiku-4-5', tier: 'standard' });
    s.completeStage('implementing', 1, {
      outcome: 'advance', durationMs: 1, costUSD: 0.01, turnsUsed: 1,
      inputTokens: 1000, outputTokens: 200, cachedReadTokens: 500, cachedNonReadTokens: 0,
    });
    s.startStage('reviewing', { model: 'gpt-5.4', tier: 'complex' });
    s.completeStage('reviewing', 1, {
      outcome: 'advance', durationMs: 1, costUSD: 0.02, turnsUsed: 1,
      inputTokens: 2000, outputTokens: 300, cachedReadTokens: 1000, cachedNonReadTokens: 0,
      verdict: 'approved',
    });
    s.seal({ status: 'done', stopReason: 'normal', realFilesChanged: [] });
    const wire = toWireRecord(s.snapshot(), {
      toolMode: 'full',
      implementerModel: 'claude-haiku-4-5', implementerTier: 'standard', mainModelFamily: 'claude',
    });
    const perStageSum = wire.stages.reduce(
      (acc, st) => acc + ((st as { mainCostUSD: number | null }).mainCostUSD ?? 0),
      0,
    );
    expect(wire.mainCostUSD).toBeCloseTo(perStageSum, 6);
  });

  it('mainCostUSD is null when mainModel is unknown to the profile registry', () => {
    // 'completely-unknown-xyz' has no profile prefix match → DEFAULT_PROFILE → null rate card
    const unknownMainSeed = { ...seed, mainModel: 'completely-unknown-xyz' };
    const s = TaskEnvelopeStore.create(unknownMainSeed);
    s.startStage('implementing', { model: 'claude-haiku-4-5', tier: 'standard' });
    s.completeStage('implementing', 1, {
      outcome: 'advance', durationMs: 1, costUSD: 0.01, turnsUsed: 1,
      inputTokens: 100, outputTokens: 10,
    });
    s.seal({ status: 'done', stopReason: 'normal', realFilesChanged: [] });
    const wire = toWireRecord(s.snapshot(), {
      toolMode: 'full',
      implementerModel: 'claude-haiku-4-5', implementerTier: 'standard', mainModelFamily: 'other',
    });
    expect(wire.mainCostUSD).toBeNull();
    expect((wire.stages[0] as { mainCostUSD: number | null }).mainCostUSD).toBeNull();
    expect(wire.costDeltaVsMainUSD).toBeNull();
  });

  it('drops PII fields: no file paths, no toolCalls, no findings text', () => {
    const s = TaskEnvelopeStore.create(seed);
    s.startStage('implementing', { model: 'm', tier: 'standard' });
    s.recordToolCall({ stage: 'implementing', tool: 'Read', filesRead: ['/secret/path'] });
    s.completeStage('implementing', 1, {
      outcome: 'advance',
      durationMs: 1,
      // A successful "done" task always has at least some LLM activity; the
      // wire layer filters out stages with zero tokens + zero cost (non-LLM
      // committing/skipped stages). Use 1 input + 1 output to keep this
      // fixture in the "kept" path while still being a degenerate sample.
      inputTokens: 1,
      outputTokens: 1,
    });
    s.seal({ status: 'done', stopReason: 'ok', realFilesChanged: ['/secret/path'] });
    const wire = toWireRecord(s.snapshot(), {
      toolMode: 'full',
      implementerModel: 'm',
      implementerTier: 'standard',
      mainModelFamily: 'other',
    });
    const json = JSON.stringify(wire);
    expect(json).not.toContain('/secret/path');
    expect(json).not.toContain('toolCalls');
    // `findingsBySeverity` is PII-safe (counts only, no claim/evidence text)
    // so it IS present on the wire. The PII rule is: no finding *text* leaks.
    expect(json).not.toContain('"claim"');
    expect(json).not.toContain('"evidence"');
  });
});
