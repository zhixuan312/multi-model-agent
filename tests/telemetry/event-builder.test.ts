import { describe, it, expect } from 'vitest';
import { buildTaskCompletedEvent } from '../../packages/core/src/events/event-builder.js';
import type { RunResult } from '../../packages/core/src/types.js';
import { HAPPY } from './fixtures/runresult.js';

function makeFixtureRunResult(overrides: Partial<RunResult>): RunResult {
  return { ...structuredClone(HAPPY), ...overrides } as RunResult;
}

describe('event-builder tier vocabulary', () => {
  it('emits tier as canonical "complex" (not "reasoning")', () => {
    const rr = makeFixtureRunResult({
      stageStats: {
        ...HAPPY.stageStats,
        implementing: {
          ...HAPPY.stageStats!.implementing,
          agentTier: 'complex',
        },
      },
    } as RunResult);
    const event = buildTaskCompletedEvent({
      route: 'delegate',
      taskSpec: { filePaths: [] },
      runResult: rr,
      client: 'test',
      mainModel: null,
    });
    const stage = event.stages.find(s => s.name === 'implementing')!;
    expect(stage.tier).toBe('complex');
  });

  it('emits tier as canonical "standard" unchanged', () => {
    const rr = makeFixtureRunResult({});
    const event = buildTaskCompletedEvent({
      route: 'delegate',
      taskSpec: { filePaths: [] },
      runResult: rr,
      client: 'test',
      mainModel: null,
    });
    const stage = event.stages.find(s => s.name === 'implementing')!;
    expect(stage.tier).toBe('standard');
  });
});

describe('event-builder v4: tierUsage and parent equivalent', () => {
  it('emits tierUsage rolled up by tier from stages', () => {
    const rr = makeFixtureRunResult({
      stageStats: {
        implementing:   { stage: 'implementing', entered: true, durationMs: 1000, costUSD: 0.01, agentTier: 'standard', modelFamily: 'claude', model: 'claude-sonnet', inputTokens: 100, outputTokens: 50, cachedReadTokens: 10, cachedNonReadTokens: 5, reasoningTokens: 20, round: 0 } as any,
        committing:     { stage: 'committing', entered: true, durationMs: 100, costUSD: 0, agentTier: 'standard', modelFamily: 'claude', model: 'claude-sonnet', round: 0 } as any,
      },
    });
    const ev = buildTaskCompletedEvent({
      route: 'delegate',
      taskSpec: { filePaths: [] },
      runResult: rr,
      client: 'test',
      mainModel: null,
    });
    expect(ev.tierUsage.standard).toBeDefined();
    expect(ev.tierUsage.standard!.inputTokens).toBe(100);
    expect(ev.tierUsage.standard!.costUSD).toBeCloseTo(0.01, 10);
  });

  it('rolls up multiple tiers independently', () => {
    const rr = makeFixtureRunResult({
      stageStats: {
        implementing:   { stage: 'implementing', entered: true, durationMs: 1000, costUSD: 0.01, agentTier: 'standard', modelFamily: 'claude', model: 'claude-sonnet', inputTokens: 100, outputTokens: 50, cachedReadTokens: 10, cachedNonReadTokens: 5, reasoningTokens: 20, round: 0 } as any,
        quality_review: { stage: 'quality_review', entered: true, durationMs: 500, costUSD: 0.10, agentTier: 'complex', modelFamily: 'openai', model: 'gpt-5', inputTokens: 200, outputTokens: 30, cachedReadTokens: 0, cachedNonReadTokens: 0, reasoningTokens: 10, round: 0, verdict: 'approved' as const, roundsUsed: 1 } as any,
        committing:     { stage: 'committing', entered: true, durationMs: 100, costUSD: 0, agentTier: 'standard', modelFamily: 'claude', model: 'claude-sonnet', round: 0 } as any,
      },
    });
    const ev = buildTaskCompletedEvent({
      route: 'delegate',
      taskSpec: { filePaths: [] },
      runResult: rr,
      client: 'test',
      mainModel: null,
    });
    expect(ev.tierUsage.standard?.inputTokens).toBe(100);
    expect(ev.tierUsage.complex?.inputTokens).toBe(200);
    expect(ev.tierUsage.standard?.costUSD).toBeCloseTo(0.01, 10);
    expect(ev.tierUsage.complex?.costUSD).toBeCloseTo(0.10, 10);
  });

  it('parentEquivalentCostUSD is computed via priceTokens when parentModel is set', () => {
    const rr = makeFixtureRunResult({
      stageStats: {
        implementing: { stage: 'implementing', entered: true, durationMs: 1000, costUSD: 0.435, agentTier: 'standard', modelFamily: 'claude', model: 'claude-sonnet', inputTokens: 1_000_000, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0, reasoningTokens: 0, round: 0 } as any,
        committing:   { stage: 'committing', entered: true, durationMs: 100, costUSD: 0, agentTier: 'standard', modelFamily: 'claude', model: 'claude-sonnet', round: 0 } as any,
      },
    });
    const ev = buildTaskCompletedEvent({
      route: 'delegate',
      taskSpec: { filePaths: [] },
      runResult: rr,
      client: 'test',
      mainModel: 'claude-opus-4-7',
    });
    expect(ev.parentEquivalentCostUSD).toBeGreaterThan(0);
    expect(ev.parentEquivalentCostUSD).toEqual(expect.any(Number));
    expect(ev.costDeltaVsParentUSD).toEqual(expect.any(Number));
  });

  it('parentModel: null → parentEquivalentCostUSD: null and costDeltaVsParentUSD: null', () => {
    const rr = makeFixtureRunResult({
      stageStats: {
        implementing: { stage: 'implementing', entered: true, durationMs: 1000, costUSD: 0.01, agentTier: 'standard', modelFamily: 'claude', model: 'claude-sonnet', inputTokens: 100, outputTokens: 50, cachedReadTokens: 0, cachedNonReadTokens: 0, reasoningTokens: 0, round: 0 } as any,
        committing:   { stage: 'committing', entered: true, durationMs: 100, costUSD: 0, agentTier: 'standard', modelFamily: 'claude', model: 'claude-sonnet', round: 0 } as any,
      },
    });
    const ev = buildTaskCompletedEvent({
      route: 'delegate',
      taskSpec: { filePaths: [] },
      runResult: rr,
      client: 'test',
      mainModel: null,
    });
    expect(ev.parentModel).toBeNull();
    expect(ev.parentEquivalentCostUSD).toBeNull();
    expect(ev.costDeltaVsParentUSD).toBeNull();
  });

  it('emits specific parentModel string alongside parentModelFamily', () => {
    const rr = makeFixtureRunResult({});
    const ev = buildTaskCompletedEvent({
      route: 'delegate',
      taskSpec: { filePaths: [] },
      runResult: rr,
      client: 'test',
      mainModel: 'claude-opus-4-7',
    });
    // parentModel is canonicalized via normalizeModel (strips vendor prefixes
    // and version suffixes). It must be non-null when parentModel is provided.
    expect(ev.parentModel).toEqual(expect.any(String));
    expect(ev.parentModelFamily).toBe('claude');
  });

  it('stage entries include round and split cached fields', () => {
    const rr = makeFixtureRunResult({
      stageStats: {
        implementing: { stage: 'implementing', entered: true, durationMs: 1000, costUSD: 0.01, agentTier: 'standard', modelFamily: 'claude', model: 'claude-sonnet', inputTokens: 100, outputTokens: 50, cachedReadTokens: 30, cachedNonReadTokens: 20, reasoningTokens: 10, round: 2 } as any,
        committing:   { stage: 'committing', entered: true, durationMs: 100, costUSD: 0, agentTier: 'standard', modelFamily: 'claude', model: 'claude-sonnet', round: 0 } as any,
      },
    });
    const ev = buildTaskCompletedEvent({
      route: 'delegate',
      taskSpec: { filePaths: [] },
      runResult: rr,
      client: 'test',
      mainModel: null,
    });
    const impl = ev.stages.find(s => s.name === 'implementing')!;
    expect((impl as any).round).toBe(2);
    expect((impl as any).cachedReadTokens).toBe(30);
    expect((impl as any).cachedNonReadTokens).toBe(20);
  });

  it('top-level token totals come from sumTokens across all stages', () => {
    const rr = makeFixtureRunResult({
      stageStats: {
        implementing:   { stage: 'implementing', entered: true, durationMs: 1000, costUSD: 0.01, agentTier: 'standard', modelFamily: 'claude', model: 'claude-sonnet', inputTokens: 100, outputTokens: 50, cachedReadTokens: 10, cachedNonReadTokens: 5, reasoningTokens: 15, round: 0 } as any,
        quality_review: { stage: 'quality_review', entered: true, durationMs: 500, costUSD: 0.005, agentTier: 'complex', modelFamily: 'openai', model: 'gpt-5', inputTokens: 200, outputTokens: 30, cachedReadTokens: 20, cachedNonReadTokens: 10, reasoningTokens: 5, round: 0, verdict: 'approved' as const, roundsUsed: 1 } as any,
        committing:     { stage: 'committing', entered: true, durationMs: 100, costUSD: 0, agentTier: 'standard', modelFamily: 'claude', model: 'claude-sonnet', round: 0 } as any,
      },
    });
    const ev = buildTaskCompletedEvent({
      route: 'delegate',
      taskSpec: { filePaths: [] },
      runResult: rr,
      client: 'test',
      mainModel: 'claude-opus-4-7',
    });
    expect(ev.inputTokens).toBe(300);
    expect(ev.outputTokens).toBe(80);
    expect(ev.cachedReadTokens).toBe(30);
    expect(ev.cachedNonReadTokens).toBe(15);
  });
});
