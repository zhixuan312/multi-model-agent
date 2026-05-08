import { describe, it, expect } from 'vitest';
import { buildTaskCompletedEvent } from '../../packages/core/src/events/event-builder.js';
import { ValidatedTaskCompletedEventSchema } from '../../packages/core/src/events/telemetry-types.js';

describe('Item 12: R4 invariant holds for all event-construction paths', () => {
  // 4.0.3+ semantics (Gap 3 fix): when stage sum exceeds runResult.durationMs,
  // totalDurationMs uses max(runResult.durationMs, stageDurationsSum) and
  // per-stage durations stay truthful (no proportional scale-down). The
  // earlier behavior — keeping total at wall-clock and shrinking stages —
  // silently masked the implementer-only durationMs bug Gap 3 fixes.
  it('uses max(runResult.durationMs, stageSum) as total; stages stay truthful', () => {
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
      mainModel: null,
    };
    const ev = buildTaskCompletedEvent(ctx);

    // total = max(5000, 12000+200) = 12200
    expect(ev.totalDurationMs).toBe(12200);

    // R4: sum of stage durations must not exceed totalDurationMs (now satisfied
    // self-consistently — total >= sum because Math.max picked sum).
    const sum = ev.stages.reduce((s, st) => s + st.durationMs, 0);
    expect(sum).toBeLessThanOrEqual(ev.totalDurationMs);

    // Per-stage durations preserved — no proportional scale-down.
    const implStage = ev.stages.find(s => s.name === 'implementing')!;
    expect(implStage.durationMs).toBe(12000);
    const commitStage = ev.stages.find(s => s.name === 'committing')!;
    expect(commitStage.durationMs).toBe(200);

    // Schema validation must pass R4
    const parsed = ValidatedTaskCompletedEventSchema.safeParse(ev);
    expect(parsed.success).toBe(true);
  });

  it('preserves all stage durations truthfully — multi-stage case', () => {
    const ctx: any = {
      route: 'execute-plan',
      taskSpec: {},
      runResult: {
        durationMs: 10000,
        stageStats: {
          implementing: { stage: 'implementing', entered: true, durationMs: 8000, costUSD: 0.04, agentTier: 'standard', modelFamily: 'claude', model: 'claude-sonnet' },
          spec_review: { stage: 'spec_review', entered: true, durationMs: 3000, costUSD: 0.001, agentTier: 'complex', modelFamily: 'claude', model: 'claude-haiku', verdict: 'approved', roundsUsed: 1 },
          spec_rework: { stage: 'spec_rework', entered: true, durationMs: 5000, costUSD: 0.03, agentTier: 'standard', modelFamily: 'claude', model: 'claude-sonnet' },
          committing: { stage: 'committing', entered: true, durationMs: 300, costUSD: 0, agentTier: 'standard', modelFamily: 'claude', model: 'claude-sonnet' },
        },
        terminationReason: { cause: 'finished', turnsUsed: 5, hasFileArtifacts: true, usedShell: false, workerSelfAssessment: 'done', wasPromoted: false },
        usage: { inputTokens: 500, outputTokens: 200, totalTokens: 700, costUSD: 0.01 },
      } as any,
      client: 'claude-code',
      mainModel: null,
    };
    const ev = buildTaskCompletedEvent(ctx);

    // totalDurationMs = max(10000, 8000+3000+5000+300) = 16300
    expect(ev.totalDurationMs).toBe(16300);

    const sum = ev.stages.reduce((s, st) => s + st.durationMs, 0);
    expect(sum).toBe(ev.totalDurationMs);

    // Per-stage durations preserved — implementing stays at 8000.
    const implStage = ev.stages.find(s => s.name === 'implementing')!;
    expect(implStage.durationMs).toBe(8000);

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
      mainModel: null,
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
      mainModel: null,
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
