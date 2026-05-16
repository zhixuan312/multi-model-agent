import { describe, it, expect } from 'vitest';
import { buildTaskCompletedEvent } from '../../packages/core/src/events/event-builder.js';
import type { RuntimeRunResult } from '../../packages/core/src/types.js';
import { HAPPY } from './fixtures/runresult.js';

function makeFixtureRunResult(overrides: Partial<RuntimeRunResult>): RuntimeRunResult {
  return { ...structuredClone(HAPPY), ...overrides } as RuntimeRunResult;
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
    } as RuntimeRunResult);
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

  it('emits subtype from taskSpec when present', () => {
    const rr = makeFixtureRunResult({});
    const event = buildTaskCompletedEvent({
      route: 'audit',
      taskSpec: { filePaths: [], subtype: 'plan' },
      runResult: rr,
      client: 'test',
      mainModel: null,
    } as any);
    expect(event.subtype).toBe('plan');
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
        review: { stage: 'review', entered: true, durationMs: 500, costUSD: 0.10, agentTier: 'complex', modelFamily: 'openai', model: 'gpt-5', inputTokens: 200, outputTokens: 30, cachedReadTokens: 0, cachedNonReadTokens: 0, reasoningTokens: 10, round: 0, verdict: 'approved' as const, roundsUsed: 1 } as any,
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

  it('mainEquivalentCostUSD is computed via priceTokens when mainModel is set', () => {
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
    expect(ev.mainEquivalentCostUSD).toBeGreaterThan(0);
    expect(ev.mainEquivalentCostUSD).toEqual(expect.any(Number));
    expect(ev.costDeltaVsMainUSD).toEqual(expect.any(Number));
  });

  it('mainModel: null → mainEquivalentCostUSD: null and costDeltaVsMainUSD: null', () => {
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
    expect(ev.mainModel).toBeNull();
    expect(ev.mainEquivalentCostUSD).toBeNull();
    expect(ev.costDeltaVsMainUSD).toBeNull();
  });

  it('emits specific mainModel string alongside mainModelFamily', () => {
    const rr = makeFixtureRunResult({});
    const ev = buildTaskCompletedEvent({
      route: 'delegate',
      taskSpec: { filePaths: [] },
      runResult: rr,
      client: 'test',
      mainModel: 'claude-opus-4-7',
    });
    // mainModel is canonicalized via normalizeModel (strips vendor prefixes
    // and version suffixes). It must be non-null when mainModel is provided.
    expect(ev.mainModel).toEqual(expect.any(String));
    expect(ev.mainModelFamily).toBe('claude');
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
        review: { stage: 'review', entered: true, durationMs: 500, costUSD: 0.005, agentTier: 'complex', modelFamily: 'openai', model: 'gpt-5', inputTokens: 200, outputTokens: 30, cachedReadTokens: 20, cachedNonReadTokens: 10, reasoningTokens: 5, round: 0, verdict: 'approved' as const, roundsUsed: 1 } as any,
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

describe('event-builder per-stage mainEquivalentCostUSD', () => {
  it('attaches mainEquivalentCostUSD to every stage when mainModel resolves', () => {
    const rr = makeFixtureRunResult({});
    const event = buildTaskCompletedEvent({
      route: 'delegate',
      taskSpec: { filePaths: [] },
      runResult: rr,
      client: 'test',
      mainModel: 'claude-opus-4-7',
    });
    for (const stage of event.stages) {
      expect(stage).toHaveProperty('mainEquivalentCostUSD');
      expect(typeof stage.mainEquivalentCostUSD === 'number' || stage.mainEquivalentCostUSD === null).toBe(true);
    }
  });
});

// 4.5.1 — pins the bug where v4.4 lifecycle moved findings to
// structuredReport but the wire builder still read pre-v4.4 rr.concerns,
// silently emitting concernCount=0 and findingsBySeverity={0,0,0,0} on
// every audit / execute-plan event despite real findings being produced.
// Two production-bug shapes: (1) audit emits findings via the
// read-only-route implementer; (2) execute-plan reviewer emits
// reviewConcerns. Both must round-trip into the wire row.
describe('event-builder finding projection (v4.4.x)', () => {
  it('counts read-only-route findings from structuredReport.findings on the wire', () => {
    const rr = makeFixtureRunResult({});
    (rr as any).structuredReport = {
      findings: [
        { severity: 'critical', category: 'security', claim: 'SQL injection in handler' },
        { severity: 'high',     category: 'review',   claim: 'missing token validation' },
        { severity: 'high',     category: 'review',   claim: 'unbounded loop' },
        { severity: 'medium',   category: 'review',   claim: 'naming inconsistency' },
        { severity: 'low',      category: 'review',   claim: 'stylistic nit' },
      ],
    };
    const ev = buildTaskCompletedEvent({
      route: 'audit',
      taskSpec: { filePaths: [] },
      runResult: rr,
      client: 'test',
      mainModel: null,
    });
    expect(ev.concernCount).toBe(5);
  });

  it('counts reviewed-write-route findings from structuredReport.reviewConcerns on the wire', () => {
    const rr = makeFixtureRunResult({
      qualityReviewStatus: 'changes_required',
      reviewVerdict: 'changes_required',
    } as RuntimeRunResult);
    (rr as any).structuredReport = {
      reviewConcerns: [
        'spec deviation: contract gate not wired',
        'missing test for error path',
        'unused import',
      ],
    };
    const ev = buildTaskCompletedEvent({
      route: 'execute-plan',
      taskSpec: { filePaths: [] },
      runResult: rr,
      client: 'test',
      mainModel: null,
    });
    expect(ev.concernCount).toBe(3);
  });

  it('buckets read-only-route findings into per-stage findingsBySeverity', () => {
    // v4.4 collapsed stageStats.{spec_review,quality_review,diff_review}
    // into a single `review` entry; the wire's buildReviewStage only fires
    // when stageStats.review.entered is true.
    const rr = makeFixtureRunResult({
      qualityReviewStatus: 'changes_required',
      stageStats: {
        ...HAPPY.stageStats,
        review: { stage: 'review', entered: true, durationMs: 1_000, costUSD: 0.001, agentTier: 'complex', modelFamily: 'claude', model: 'claude-sonnet', verdict: 'changes_required', roundsUsed: 1 } as any,
      } as RuntimeRunResult['stageStats'],
    } as RuntimeRunResult);
    (rr as any).structuredReport = {
      findings: [
        { severity: 'critical', category: 'security', claim: 'c1' },
        { severity: 'critical', category: 'security', claim: 'c2' },
        { severity: 'high',     category: 'review',   claim: 'h1' },
        { severity: 'medium',   category: 'review',   claim: 'm1' },
        { severity: 'low',      category: 'review',   claim: 'l1' },
      ],
    };
    const ev = buildTaskCompletedEvent({
      route: 'delegate',
      taskSpec: { filePaths: [] },
      runResult: rr,
      client: 'test',
      mainModel: null,
    });
    const reviewStage = ev.stages.find(s => s.name === 'review') as { findingsBySeverity: { critical: number; high: number; medium: number; low: number } } | undefined;
    expect(reviewStage).toBeDefined();
    expect(reviewStage!.findingsBySeverity).toEqual({ critical: 2, high: 1, medium: 1, low: 1 });
  });

  it('defaults reviewConcerns to medium severity (reviewer prose has no per-clause severity)', () => {
    const rr = makeFixtureRunResult({
      qualityReviewStatus: 'changes_required',
      stageStats: {
        ...HAPPY.stageStats,
        review: { stage: 'review', entered: true, durationMs: 1_000, costUSD: 0.001, agentTier: 'complex', modelFamily: 'claude', model: 'claude-sonnet', verdict: 'changes_required', roundsUsed: 1 } as any,
      } as RuntimeRunResult['stageStats'],
    } as RuntimeRunResult);
    (rr as any).structuredReport = {
      reviewConcerns: ['a', 'b', 'c', 'd'],
    };
    const ev = buildTaskCompletedEvent({
      route: 'delegate',
      taskSpec: { filePaths: [] },
      runResult: rr,
      client: 'test',
      mainModel: null,
    });
    const reviewStage = ev.stages.find(s => s.name === 'review') as { findingsBySeverity: { critical: number; high: number; medium: number; low: number } } | undefined;
    expect(reviewStage).toBeDefined();
    expect(reviewStage!.findingsBySeverity.medium).toBe(4);
    expect(reviewStage!.findingsBySeverity.critical).toBe(0);
    expect(reviewStage!.findingsBySeverity.high).toBe(0);
    expect(reviewStage!.findingsBySeverity.low).toBe(0);
  });

  it('synthesizes a review stage entry on read-only routes so findingsBySeverity reaches the wire', () => {
    // v5 puts findingsBySeverity on the review stage entry. Read-only
    // routes (audit/review/debug/investigate) hardcode reviewPolicy:'none'
    // so no actual reviewer runs — but the implementer IS the finding
    // producer on these routes. The event-builder synthesizes a
    // zero-metric review stage entry with verdict:'annotated' so the
    // per-severity breakdown reaches the wire (and the warehouse columns
    // that read stages[?name=review].findingsBySeverity).
    const rr = makeFixtureRunResult({});
    (rr as any).structuredReport = {
      findings: [
        { severity: 'critical', category: 'security', claim: 'c1' },
        { severity: 'high',     category: 'review',   claim: 'h1' },
        { severity: 'high',     category: 'review',   claim: 'h2' },
        { severity: 'medium',   category: 'review',   claim: 'm1' },
      ],
    };
    const ev = buildTaskCompletedEvent({
      route: 'audit',
      taskSpec: { filePaths: [] },
      runResult: rr,
      client: 'test',
      mainModel: null,
    });
    const review = ev.stages.find(s => s.name === 'review') as { verdict: string; findingsBySeverity: { critical: number; high: number; medium: number; low: number }; durationMs: number; costUSD: number | null } | undefined;
    expect(review).toBeDefined();
    expect(review!.verdict).toBe('annotated');
    expect(review!.findingsBySeverity).toEqual({ critical: 1, high: 2, medium: 1, low: 0 });
    expect(review!.durationMs).toBe(0);
    expect(review!.costUSD).toBe(0);
  });

  it('does NOT synthesize a review stage when read-only-route has zero findings', () => {
    const rr = makeFixtureRunResult({});
    (rr as any).structuredReport = { findings: [] };
    const ev = buildTaskCompletedEvent({
      route: 'audit',
      taskSpec: { filePaths: [] },
      runResult: rr,
      client: 'test',
      mainModel: null,
    });
    expect(ev.stages.find(s => s.name === 'review')).toBeUndefined();
  });

  it('caps concernCount at 150 even when more findings exist', () => {
    const rr = makeFixtureRunResult({});
    const findings = Array.from({ length: 250 }, (_, i) => ({
      severity: 'medium', category: 'review', claim: `f-${i}`,
    }));
    (rr as any).structuredReport = { findings };
    const ev = buildTaskCompletedEvent({
      route: 'audit',
      taskSpec: { filePaths: [] },
      runResult: rr,
      client: 'test',
      mainModel: null,
    });
    expect(ev.concernCount).toBe(150);
  });
});

describe('event-builder tier attribution (spec 2026-05-16)', () => {
  it('T1: tierUsage.standard.model is implementer, not "custom", when synthetic stages share tier', () => {
    const rr = makeFixtureRunResult({
      stageStats: {
        ...HAPPY.stageStats!,
        implementing: {
          ...HAPPY.stageStats!.implementing,
          model: 'claude-haiku-4-5',
          agentTier: 'standard',
          costUSD: 0.05,
        },
        verifying: {
          ...HAPPY.stageStats!.implementing,
          model: 'claude-haiku-4-5',
          agentTier: 'standard',
          costUSD: 0.01,
        },
      },
      models: { implementer: 'claude-haiku-4-5' },
    } as RuntimeRunResult);
    const event = buildTaskCompletedEvent({
      route: 'investigate',
      taskSpec: { filePaths: [] },
      runResult: rr,
      client: 'test',
      mainModel: 'claude-opus-4-7',
      reviewPolicy: 'none',
    } as any);
    expect(event.tierUsage.standard?.model).toBe('claude-haiku-4-5');
  });

  it('T2: tierUsage.standard.model is implementer when rework also fires', () => {
    const rr = makeFixtureRunResult({
      stageStats: {
        ...HAPPY.stageStats!,
        implementing: { ...HAPPY.stageStats!.implementing, model: 'claude-haiku-4-5', agentTier: 'standard', costUSD: 0.05 },
        spec_rework:  { ...HAPPY.stageStats!.implementing, model: 'claude-haiku-4-5', agentTier: 'standard', costUSD: 0.03 },
      },
      models: { implementer: 'claude-haiku-4-5' },
    } as RuntimeRunResult);
    const event = buildTaskCompletedEvent({
      route: 'delegate',
      taskSpec: { filePaths: [] },
      runResult: rr,
      client: 'test',
      mainModel: 'claude-opus-4-7',
    } as any);
    expect(event.tierUsage.standard?.model).toBe('claude-haiku-4-5');
  });

  it('T3: complex tier reports implementer; standard tier absent', () => {
    const rr = makeFixtureRunResult({
      stageStats: {
        ...HAPPY.stageStats!,
        implementing: { ...HAPPY.stageStats!.implementing, model: 'gpt-5.4', agentTier: 'complex', costUSD: 4.9 },
        spec_review:  { ...HAPPY.stageStats!.implementing, model: 'gpt-5.4', agentTier: 'complex', costUSD: 0.2 },
      },
      models: { implementer: 'gpt-5.4' },
    } as RuntimeRunResult);
    const event = buildTaskCompletedEvent({
      route: 'delegate',
      taskSpec: { filePaths: [] },
      runResult: rr,
      client: 'test',
      mainModel: 'claude-opus-4-7',
    } as any);
    expect(event.tierUsage.complex?.model).toBe('gpt-5.4');
    expect(event.tierUsage.standard).toBeUndefined();
  });

  it('T4: tierUsage.standard absent when only synthetic stages contribute', () => {
    const rr = makeFixtureRunResult({
      stageStats: {
        ...HAPPY.stageStats!,
        implementing: { ...HAPPY.stageStats!.implementing, model: 'gpt-5.4', agentTier: 'complex', costUSD: 4.9 },
      },
      models: { implementer: 'gpt-5.4' },
    } as RuntimeRunResult);
    const event = buildTaskCompletedEvent({
      route: 'investigate',
      taskSpec: { filePaths: [] },
      runResult: rr,
      client: 'test',
      mainModel: 'claude-opus-4-7',
      reviewPolicy: 'none',
    } as any);
    expect(event.tierUsage.standard).toBeUndefined();
    expect(event.tierUsage.complex?.model).toBe('gpt-5.4');
  });
});
