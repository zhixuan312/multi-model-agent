import { describe, it, expect } from 'vitest';
import { buildTaskCompletedEvent } from '../../packages/core/src/telemetry/event-builder.js';
import { ValidatedTaskCompletedEventSchema } from '../../packages/core/src/telemetry/types.js';

describe('Item 12: R4 invariant holds for all event-construction paths', () => {
  it('keeps totalDurationMs as wall-clock when stage sum exceeds runResult.durationMs', () => {
    // Salvage-promotion in reviewed-lifecycle can cause stage durations to
    // double-count overlapping time. The builder must NOT inflate
    // totalDurationMs to mask the overlap — it must keep wall-clock truth
    // and proportionally clamp stage durations down.
    const ctx: any = {
      route: 'delegate',
      taskSpec: {},
      runResult: {
        durationMs: 5000,
        stageStats: {
          implementing: { stage: 'implementing', entered: true, durationMs: 12000, costUSD: 0.05, agentTier: 'standard', modelFamily: 'claude', model: 'claude-sonnet' },
          committing: { stage: 'committing', entered: true, durationMs: 200, costUSD: 0, agentTier: 'standard', modelFamily: 'claude', model: 'claude-sonnet' },
        },
        terminationReason: { cause: 'finished', turnsUsed: 3, hasFileArtifacts: true, usedShell: false, workerSelfAssessment: 'done', wasPromoted: false },
        usage: { inputTokens: 200, outputTokens: 100, totalTokens: 300, costUSD: 0.005 },
      } as any,
      client: 'claude-code',
      parentModel: null,
    };
    const ev = buildTaskCompletedEvent(ctx);

    // totalDurationMs must be wall-clock truth, NOT inflated to stage sum
    expect(ev.totalDurationMs).toBe(5000);

    // R4: sum of stage durations must not exceed totalDurationMs
    const sum = ev.stages.reduce((s, st) => s + st.durationMs, 0);
    expect(sum).toBeLessThanOrEqual(ev.totalDurationMs);

    // Individual stages must not exceed total
    for (const st of ev.stages) {
      expect(st.durationMs).toBeLessThanOrEqual(ev.totalDurationMs);
    }

    // Schema validation must pass R4
    const parsed = ValidatedTaskCompletedEventSchema.safeParse(ev);
    expect(parsed.success).toBe(true);
  });

  it('proportionally scales stages when multiple stages overlap', () => {
    const ctx: any = {
      route: 'execute-plan',
      taskSpec: {},
      runResult: {
        durationMs: 10000,
        stageStats: {
          implementing: { stage: 'implementing', entered: true, durationMs: 8000, costUSD: 0.04, agentTier: 'standard', modelFamily: 'claude', model: 'claude-sonnet' },
          spec_review: { stage: 'spec_review', entered: true, durationMs: 3000, costUSD: 0.001, agentTier: 'standard', modelFamily: 'claude', model: 'claude-haiku', verdict: 'approved', roundsUsed: 1 },
          spec_rework: { stage: 'spec_rework', entered: true, durationMs: 5000, costUSD: 0.03, agentTier: 'standard', modelFamily: 'claude', model: 'claude-sonnet' },
          committing: { stage: 'committing', entered: true, durationMs: 300, costUSD: 0, agentTier: 'standard', modelFamily: 'claude', model: 'claude-sonnet' },
        },
        terminationReason: { cause: 'finished', turnsUsed: 5, hasFileArtifacts: true, usedShell: false, workerSelfAssessment: 'done', wasPromoted: false },
        usage: { inputTokens: 500, outputTokens: 200, totalTokens: 700, costUSD: 0.01 },
      } as any,
      client: 'claude-code',
      parentModel: null,
    };
    const ev = buildTaskCompletedEvent(ctx);

    // totalDurationMs = wall-clock, not 8000+3000+5000+300 = 16300
    expect(ev.totalDurationMs).toBe(10000);

    const sum = ev.stages.reduce((s, st) => s + st.durationMs, 0);
    expect(sum).toBeLessThanOrEqual(ev.totalDurationMs);

    // implementing stage should have been scaled largest (proportional)
    const implStage = ev.stages.find(s => s.name === 'implementing')!;
    expect(implStage.durationMs).toBeGreaterThan(0);
    expect(implStage.durationMs).toBeLessThan(8000); // must be reduced from original

    const parsed = ValidatedTaskCompletedEventSchema.safeParse(ev);
    expect(parsed.success).toBe(true);
  });

  it('uses stage sum as fallback when runResult.durationMs is null', () => {
    const ctx: any = {
      route: 'delegate',
      taskSpec: {},
      runResult: {
        durationMs: null,
        stageStats: {
          implementing: { stage: 'implementing', entered: true, durationMs: 5000, costUSD: 0.02, agentTier: 'standard', modelFamily: 'claude', model: 'claude-sonnet' },
          committing: { stage: 'committing', entered: true, durationMs: 200, costUSD: 0, agentTier: 'standard', modelFamily: 'claude', model: 'claude-sonnet' },
        },
        terminationReason: { cause: 'finished', turnsUsed: 3, hasFileArtifacts: true, usedShell: false, workerSelfAssessment: 'done', wasPromoted: false },
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUSD: 0.002 },
      } as any,
      client: 'claude-code',
      parentModel: null,
    };
    const ev = buildTaskCompletedEvent(ctx);

    // When durationMs is null, fall back to stage sum
    expect(ev.totalDurationMs).toBe(5200);

    const sum = ev.stages.reduce((s, st) => s + st.durationMs, 0);
    expect(sum).toBeLessThanOrEqual(ev.totalDurationMs);

    const parsed = ValidatedTaskCompletedEventSchema.safeParse(ev);
    expect(parsed.success).toBe(true);
  });

  it('no-op when stages sum <= runResult.durationMs (normal case)', () => {
    const ctx: any = {
      route: 'delegate',
      taskSpec: {},
      runResult: {
        durationMs: 10000,
        stageStats: {
          implementing: { stage: 'implementing', entered: true, durationMs: 6000, costUSD: 0.03, agentTier: 'standard', modelFamily: 'claude', model: 'claude-sonnet' },
          committing: { stage: 'committing', entered: true, durationMs: 200, costUSD: 0, agentTier: 'standard', modelFamily: 'claude', model: 'claude-sonnet' },
        },
        terminationReason: { cause: 'finished', turnsUsed: 3, hasFileArtifacts: true, usedShell: false, workerSelfAssessment: 'done', wasPromoted: false },
        usage: { inputTokens: 200, outputTokens: 100, totalTokens: 300, costUSD: 0.005 },
      } as any,
      client: 'claude-code',
      parentModel: null,
    };
    const ev = buildTaskCompletedEvent(ctx);

    // Normal case: totalDurationMs = runResult.durationMs, stages unchanged
    expect(ev.totalDurationMs).toBe(10000);

    const sum = ev.stages.reduce((s, st) => s + st.durationMs, 0);
    expect(sum).toBe(6200); // stages unchanged
    expect(sum).toBeLessThanOrEqual(ev.totalDurationMs);

    const parsed = ValidatedTaskCompletedEventSchema.safeParse(ev);
    expect(parsed.success).toBe(true);
  });
});
