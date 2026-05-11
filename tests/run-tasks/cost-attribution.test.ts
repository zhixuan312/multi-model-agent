import { describe, it, expect } from 'vitest';
import { buildTaskCompletedEvent } from '../../packages/core/src/events/event-builder.js';
import { priceTokens, resolveRateCard, type TokenCounts } from '../../packages/core/src/bounded-execution/cost-compute.js';
import { sumTokens, rollupByTier } from '../../packages/core/src/bounded-execution/cost-rollup.js';
import type { RunResult, StageStatsMap } from '../../packages/core/src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStageStats(
  name: string,
  overrides: Partial<{
    entered: boolean;
    durationMs: number | null;
    costUSD: number | null;
    agentTier: 'standard' | 'complex' | null;
    model: string | null;
    inputTokens: number;
    outputTokens: number;
    cachedReadTokens: number;
    cachedNonReadTokens: number;
    round: number;
    verdict: string | null;
    roundsUsed: number | null;
    toolCallCount: number;
    filesReadCount: number;
    filesWrittenCount: number;
    turnCount: number;
    maxIdleMs: number;
    totalIdleMs: number;
    activityEvents: number;
    outcome: string | null;
    skipReason: string | null;
  }> = {},
) {
  const base = {
    entered: true,
    durationMs: 1000,
    costUSD: 0.01 as number | null,
    agentTier: 'standard' as const,
    modelFamily: null as string | null,
    model: 'claude-sonnet',
    inputTokens: 100,
    outputTokens: 50,
    cachedReadTokens: 0,
    cachedNonReadTokens: 0,
    round: 0,
    toolCallCount: 3,
    filesReadCount: 2,
    filesWrittenCount: 1,
    turnCount: 2,
    maxIdleMs: 500,
    totalIdleMs: 2000,
    activityEvents: 10,
    ...overrides,
  };
  const stage = overrides.stage ?? name;
  return { stage, ...base } as any;
}

// Zero-token committing stage — used as default so committing doesn't
// contaminate tier rollups in token/cost math tests.
const ZERO_COMMITTING = makeStageStats('committing', {
  inputTokens: 0, outputTokens: 0,
  cachedReadTokens: 0, cachedNonReadTokens: 0,
  costUSD: 0, turnCount: 0, toolCallCount: 0,
  filesReadCount: 0, filesWrittenCount: 0,
});

function makeRunResult(overrides: Partial<RunResult> = {}): RunResult {
  const defaultStageStats: StageStatsMap = {
    implementing: makeStageStats('implementing', { agentTier: 'standard', costUSD: 0.01 }),
    annotating:   makeStageStats('annotating', { entered: false, durationMs: null, costUSD: null, agentTier: null, model: null, outcome: 'not_applicable', skipReason: 'not_applicable' }),
    review:       makeStageStats('review', { entered: false, durationMs: null, costUSD: null, agentTier: null, model: null, verdict: 'not_applicable', roundsUsed: null }),
    rework:       makeStageStats('rework', { entered: false, durationMs: null, costUSD: null, agentTier: null, model: null }),
    committing:   ZERO_COMMITTING,
  };

  return {
    output: 'mocked ok',
    status: 'ok',
    usage: { inputTokens: 100, outputTokens: 50, cachedReadTokens: 0, cachedNonReadTokens: 0 },
    cost: { costUSD: 0.01, costDeltaVsMainUSD: null },
    turns: 2,
    filesRead: ['a.ts'],
    filesWritten: ['b.ts'],
    toolCalls: ['read_file', 'edit_file'],
    outputIsDiagnostic: false,
    escalationLog: [{ provider: 'mock', status: 'ok', turns: 2, inputTokens: 100, outputTokens: 50, costUSD: 0.01, initialPromptLengthChars: 50, initialPromptHash: 'abc' }],
    durationMs: 5000,
    agents: { implementer: 'standard', specReviewer: 'complex', qualityReviewer: 'complex' },
    models: { implementer: 'claude-sonnet', specReviewer: 'gpt-5', qualityReviewer: 'gpt-5' },
    workerStatus: 'done',
    specReviewStatus: 'approved',
    qualityReviewStatus: 'approved',
    terminationReason: { cause: 'finished', turnsUsed: 2, hasFileArtifacts: true, usedShell: false, workerSelfAssessment: 'done', wasPromoted: false },
    stageStats: defaultStageStats,
    ...overrides,
  } as RunResult;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cost attribution: mixed-tier task with rework round', () => {
  it('tier rollup sums to total; parent equivalent uses summed tokens at parent rate', () => {
    // Build a mixed-tier RunResult:
    // - implementing (standard tier): specific tokens + cost
    // - spec_review (complex tier): specific tokens + cost
    const rr = makeRunResult({
      durationMs: 12_000,
      stageStats: {
        implementing: makeStageStats('implementing', {
          agentTier: 'standard',
          model: 'deepseek-v4-pro',
          costUSD: 0.435,
          inputTokens: 1_000_000,
          outputTokens: 500_000,
          cachedReadTokens: 200_000,
          cachedNonReadTokens: 50_000,
        }),
        review: makeStageStats('review', {
          agentTier: 'complex',
          model: 'gpt-5.5',
          costUSD: 5.0,
          inputTokens: 500_000,
          outputTokens: 100_000,
          cachedReadTokens: 0,
          cachedNonReadTokens: 0,
          verdict: 'approved',
          roundsUsed: 1,
        }),
        annotating: makeStageStats('annotating', { entered: false, durationMs: null, costUSD: null, agentTier: null, model: null, outcome: 'not_applicable', skipReason: 'not_applicable' }),
        rework:     makeStageStats('rework', { entered: false, durationMs: null, costUSD: null, agentTier: null, model: null }),
        committing: ZERO_COMMITTING,
      },
    });

    const event = buildTaskCompletedEvent({
      route: 'delegate',
      taskSpec: { filePaths: [] },
      runResult: rr,
      client: 'test',
      mainModel: 'claude-opus-4-7',
    });

    // --- Shape assertions ---
    expect(event.mainModel).toEqual(expect.any(String));
    expect(event.mainModelFamily).toBe('claude');
    expect(event.tierUsage.standard).toBeDefined();
    expect(event.tierUsage.complex).toBeDefined();

    // --- Cost rollup: Σ tierUsage[T].costUSD === totalCostUSD ---
    const standardCost = event.tierUsage.standard!.costUSD ?? 0;
    const complexCost  = event.tierUsage.complex!.costUSD  ?? 0;
    expect(event.totalCostUSD).not.toBeNull();
    expect(standardCost + complexCost).toBeCloseTo(event.totalCostUSD!, 6);

    // --- Tier token sums ---
    expect(event.tierUsage.standard!.inputTokens).toBe(1_000_000);
    expect(event.tierUsage.standard!.outputTokens).toBe(500_000);
    expect(event.tierUsage.standard!.cachedReadTokens).toBe(200_000);
    expect(event.tierUsage.standard!.cachedNonReadTokens).toBe(50_000);

    expect(event.tierUsage.complex!.inputTokens).toBe(500_000);
    expect(event.tierUsage.complex!.outputTokens).toBe(100_000);

    // --- Parent-equivalent: priceTokens(sum of all tier tokens, parent rate card) ---
    const parentCard = resolveRateCard('claude-opus-4-7');
    expect(parentCard).not.toBeNull();

    const sumIn  = event.tierUsage.standard!.inputTokens + event.tierUsage.complex!.inputTokens;
    const sumOut = event.tierUsage.standard!.outputTokens + event.tierUsage.complex!.outputTokens;
    const sumCachedRead     = event.tierUsage.standard!.cachedReadTokens     + event.tierUsage.complex!.cachedReadTokens;
    const sumCachedCreation = event.tierUsage.standard!.cachedNonReadTokens + event.tierUsage.complex!.cachedNonReadTokens;

    const expectedParent = priceTokens(
      {
        inputTokens: sumIn,
        outputTokens: sumOut,
        cachedReadTokens: sumCachedRead,
        cachedNonReadTokens: sumCachedCreation,
      },
      parentCard!,
    );

    expect(event.mainEquivalentCostUSD).toBeCloseTo(expectedParent, 6);

    // --- costDeltaVsMainUSD = totalCostUSD − mainEquivalentCostUSD ---
    expect(event.costDeltaVsMainUSD).toBeCloseTo(
      event.totalCostUSD! - event.mainEquivalentCostUSD!,
      6,
    );
  });

  it('top-level token totals equal sumTokens of all stages', () => {
    const rr = makeRunResult({
      stageStats: {
        implementing: makeStageStats('implementing', {
          agentTier: 'standard',
          inputTokens: 1000, outputTokens: 500,
          cachedReadTokens: 100, cachedNonReadTokens: 50,
          costUSD: 0.10,
        }),
        review: makeStageStats('review', {
          agentTier: 'complex',
          inputTokens: 2000, outputTokens: 300,
          cachedReadTokens: 200, cachedNonReadTokens: 100,
          costUSD: 0.50,
          verdict: 'approved', roundsUsed: 1,
        }),
        annotating: makeStageStats('annotating', { entered: false, durationMs: null, costUSD: null, agentTier: null, model: null, outcome: 'not_applicable', skipReason: 'not_applicable' }),
        rework:     makeStageStats('rework', { entered: false, durationMs: null, costUSD: null, agentTier: null, model: null }),
        committing: ZERO_COMMITTING,
      },
    });

    const event = buildTaskCompletedEvent({
      route: 'delegate',
      taskSpec: { filePaths: [] },
      runResult: rr,
      client: 'test',
      mainModel: 'claude-opus-4-7',
    });

    // Σ stages === top-level fields
    const stageTokens = event.stages.map(s => ({
      inputTokens: s.inputTokens,
      outputTokens: s.outputTokens,
      cachedReadTokens: s.cachedReadTokens ?? 0,
      cachedNonReadTokens: s.cachedNonReadTokens ?? 0,
    }));
    const summed = sumTokens(stageTokens);

    expect(event.inputTokens).toBe(summed.inputTokens);
    expect(event.outputTokens).toBe(summed.outputTokens);
    expect(event.cachedReadTokens).toBe(summed.cachedReadTokens);
    expect(event.cachedNonReadTokens).toBe(summed.cachedNonReadTokens);
  });

  it('mainModel: null → mainEquivalentCostUSD and costDeltaVsMainUSD are null', () => {
    const rr = makeRunResult({
      stageStats: {
        implementing:   makeStageStats('implementing', { agentTier: 'standard', inputTokens: 500, outputTokens: 200, cachedReadTokens: 0, cachedNonReadTokens: 0, costUSD: 0.005 }),
        annotating:      makeStageStats('annotating', { entered: false, durationMs: null, costUSD: null, agentTier: null, model: null, outcome: 'not_applicable', skipReason: 'not_applicable' }),
        review:    makeStageStats('review', { entered: false, durationMs: null, costUSD: null, agentTier: null, model: null, verdict: 'not_applicable', roundsUsed: null }),
        rework:    makeStageStats('rework', { entered: false, durationMs: null, costUSD: null, agentTier: null, model: null }),
        committing:     ZERO_COMMITTING,
      },
    });

    const event = buildTaskCompletedEvent({
      route: 'delegate',
      taskSpec: { filePaths: [] },
      runResult: rr,
      client: 'test',
      mainModel: null,
    });

    expect(event.mainModel).toBeNull();
    expect(event.mainEquivalentCostUSD).toBeNull();
    expect(event.costDeltaVsMainUSD).toBeNull();
  });

  it('costDeltaVsMainUSD sign: positive when worker > parent, negative when saved', () => {
    // Worker is more expensive than parent → positive delta
    const rrExpensive = makeRunResult({
      stageStats: {
        implementing:   makeStageStats('implementing', { agentTier: 'complex', model: 'gpt-5.5', inputTokens: 500_000, outputTokens: 100_000, cachedReadTokens: 0, cachedNonReadTokens: 0, costUSD: 20.0 }),
        annotating:      makeStageStats('annotating', { entered: false, durationMs: null, costUSD: null, agentTier: null, model: null, outcome: 'not_applicable', skipReason: 'not_applicable' }),
        review:    makeStageStats('review', { entered: false, durationMs: null, costUSD: null, agentTier: null, model: null, verdict: 'not_applicable', roundsUsed: null }),
        rework:    makeStageStats('rework', { entered: false, durationMs: null, costUSD: null, agentTier: null, model: null }),
        committing:     ZERO_COMMITTING,
      },
    });

    const eventExpensive = buildTaskCompletedEvent({
      route: 'delegate',
      taskSpec: { filePaths: [] },
      runResult: rrExpensive,
      client: 'test',
      mainModel: 'claude-haiku-4-6',
    });

    expect(eventExpensive.costDeltaVsMainUSD).toBeGreaterThan(0);

    // Worker is cheaper than parent → negative delta (saved money)
    const rrCheap = makeRunResult({
      stageStats: {
        implementing:   makeStageStats('implementing', { agentTier: 'standard', model: 'claude-haiku-4-6', inputTokens: 100_000, outputTokens: 10_000, cachedReadTokens: 0, cachedNonReadTokens: 0, costUSD: 0.001 }),
        annotating:      makeStageStats('annotating', { entered: false, durationMs: null, costUSD: null, agentTier: null, model: null, outcome: 'not_applicable', skipReason: 'not_applicable' }),
        review:    makeStageStats('review', { entered: false, durationMs: null, costUSD: null, agentTier: null, model: null, verdict: 'not_applicable', roundsUsed: null }),
        rework:    makeStageStats('rework', { entered: false, durationMs: null, costUSD: null, agentTier: null, model: null }),
        committing:     ZERO_COMMITTING,
      },
    });

    const eventCheap = buildTaskCompletedEvent({
      route: 'delegate',
      taskSpec: { filePaths: [] },
      runResult: rrCheap,
      client: 'test',
      mainModel: 'claude-opus-4-7',
    });

    expect(eventCheap.costDeltaVsMainUSD).toBeLessThan(0);
  });

  it('honest-null behavior at the event-builder level: null stageStats cost coerces to 0 in stage entry', () => {
    // extractStageData(raw.costUSD ?? 0) converts null to 0 so the built
    // stage entry never carries null costUSD. The null→0 conversion means
    // totalCostUSD is computable even when stageStats have null cost.
    const rr = makeRunResult({
      stageStats: {
        implementing: makeStageStats('implementing', {
          agentTier: 'standard',
          inputTokens: 100, outputTokens: 50,
          cachedReadTokens: 0, cachedNonReadTokens: 0,
          costUSD: null, // will become 0 in stage entry
        }),
        annotating:      makeStageStats('annotating', { entered: false, durationMs: null, costUSD: null, agentTier: null, model: null, outcome: 'not_applicable', skipReason: 'not_applicable' }),
        review:    makeStageStats('review', { entered: false, durationMs: null, costUSD: null, agentTier: null, model: null, verdict: 'not_applicable', roundsUsed: null }),
        rework:    makeStageStats('rework', { entered: false, durationMs: null, costUSD: null, agentTier: null, model: null }),
        committing:     ZERO_COMMITTING,
      },
    });

    const event = buildTaskCompletedEvent({
      route: 'delegate',
      taskSpec: { filePaths: [] },
      runResult: rr,
      client: 'test',
      mainModel: 'claude-opus-4-7',
    });

    // Stage entry has costUSD: 0 (null coerced via extractStageData)
    const impl = event.stages.find(s => s.name === 'implementing')!;
    expect(impl.costUSD).toBe(0);

    // totalCostUSD is computable (not null) because all stage entries have non-null cost
    expect(event.totalCostUSD).toBe(0);

    // mainEquivalentCostUSD still computable from token counts
    expect(event.mainEquivalentCostUSD).not.toBeNull();
  });
});

describe('multi-round stage entries', () => {
  it('stage entries include round and split cached fields', () => {
    const rr = makeRunResult({
      reviewVerdict: 'changes_required',
      specReviewStatus: 'changes_required',
      qualityReviewStatus: 'changes_required',
      reviewRounds: { spec: 2, quality: 1, metadata: 1, cap: 5 },
      stageStats: {
        implementing: makeStageStats('implementing', {
          agentTier: 'standard',
          model: 'claude-sonnet',
          inputTokens: 500, outputTokens: 200,
          cachedReadTokens: 100, cachedNonReadTokens: 50,
          round: 2,
          costUSD: 0.015,
        }),
        review: makeStageStats('review', {
          agentTier: 'complex',
          model: 'gpt-5.5',
          inputTokens: 300, outputTokens: 80,
          cachedReadTokens: 20, cachedNonReadTokens: 10,
          round: 1,
          costUSD: 0.005,
          verdict: 'changes_required',
          roundsUsed: 2,
        }),
        annotating: makeStageStats('annotating', { entered: false, durationMs: null, costUSD: null, agentTier: null, model: null, outcome: 'not_applicable', skipReason: 'not_applicable' }),
        rework:     makeStageStats('rework', { entered: false, durationMs: null, costUSD: null, agentTier: null, model: null }),
        committing: ZERO_COMMITTING,
      },
    });

    const event = buildTaskCompletedEvent({
      route: 'delegate',
      taskSpec: { filePaths: [] },
      runResult: rr,
      client: 'test',
      mainModel: null,
    });

    const impl = event.stages.find(s => s.name === 'implementing')!;
    expect(impl).toBeDefined();
    expect((impl as any).round).toBe(2);
    expect((impl as any).cachedReadTokens).toBe(100);
    expect((impl as any).cachedNonReadTokens).toBe(50);

    const specReview = event.stages.find(s => s.name === 'review')!;
    expect(specReview).toBeDefined();
    expect((specReview as any).round).toBe(1);
    expect((specReview as any).cachedReadTokens).toBe(20);
    expect((specReview as any).cachedNonReadTokens).toBe(10);

    // Review stage carries verdict and roundsUsed
    expect((specReview as any).verdict).toBe('changes_required');
    expect((specReview as any).roundsUsed).toBe(2);
  });

  it('rollupByTier aggregates independently per tier', () => {
    const stages = [
      { tier: 'standard' as const, model: 'claude-sonnet', costUSD: 0.01 as number | null, inputTokens: 100, outputTokens: 50, cachedReadTokens: 30, cachedNonReadTokens: 20 },
      { tier: 'standard' as const, model: 'claude-sonnet', costUSD: 0.02 as number | null, inputTokens: 200, outputTokens: 100, cachedReadTokens: 60, cachedNonReadTokens: 40 },
      { tier: 'complex' as const, model: 'gpt-5.5', costUSD: 0.50 as number | null, inputTokens: 300, outputTokens: 150, cachedReadTokens: 0, cachedNonReadTokens: 0 },
      { tier: 'complex' as const, model: 'gpt-5.5', costUSD: 0.30 as number | null, inputTokens: 400, outputTokens: 200, cachedReadTokens: 0, cachedNonReadTokens: 0 },
    ];

    const rolled = rollupByTier(stages);

    expect(rolled.standard).toBeDefined();
    expect(rolled.complex).toBeDefined();
    expect(rolled.standard!.inputTokens).toBe(300);
    expect(rolled.standard!.outputTokens).toBe(150);
    expect(rolled.standard!.cachedReadTokens).toBe(90);
    expect(rolled.standard!.cachedNonReadTokens).toBe(60);
    expect(rolled.standard!.costUSD).toBeCloseTo(0.03, 10);

    expect(rolled.complex!.inputTokens).toBe(700);
    expect(rolled.complex!.outputTokens).toBe(350);
    expect(rolled.complex!.costUSD).toBeCloseTo(0.80, 10);
  });

  it('rollupByTier honest-null: any null costUSD in a tier poisons that tier total', () => {
    const stages = [
      { tier: 'standard' as const, model: 'claude-sonnet', costUSD: 0.01 as number | null, inputTokens: 100, outputTokens: 50, cachedReadTokens: 0, cachedNonReadTokens: 0 },
      { tier: 'standard' as const, model: 'claude-sonnet', costUSD: null as number | null, inputTokens: 100, outputTokens: 50, cachedReadTokens: 0, cachedNonReadTokens: 0 },
    ];

    const rolled = rollupByTier(stages);
    expect(rolled.standard!.costUSD).toBeNull();
  });
});
