import { describe, it, expect } from 'vitest';
import { buildTaskCompletedEvent } from '../../packages/core/src/telemetry/event-builder.js';
import { ValidatedTaskCompletedEventSchema } from '../../packages/core/src/telemetry/types.js';

describe('Item 12: R4 invariant holds for all event-construction paths', () => {
  it('sum of stage durationMs ≤ totalDurationMs after builder normalization', () => {
    const ctx: any = {
      route: 'execute-plan',
      taskSpec: {},
      runResult: {
        durationMs: 100,
        stageStats: {
          implementing: { stage: 'implementing', entered: true, durationMs: 60, costUSD: 0.004, agentTier: 'standard', modelFamily: 'claude', model: 'claude-sonnet' },
          spec_review: { stage: 'spec_review', entered: true, durationMs: 80, costUSD: 0.001, agentTier: 'standard', modelFamily: 'claude', model: 'claude-haiku', verdict: 'approved', roundsUsed: 1 },
        },
        terminationReason: { cause: 'finished', turnsUsed: 3, hasFileArtifacts: true, usedShell: false, workerSelfAssessment: 'done', wasPromoted: false },
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUSD: 0.001 },
      } as any,
      client: 'claude-code',
      parentModel: null,
    };
    const ev = buildTaskCompletedEvent(ctx);
    const sum = ev.stages.reduce((s, st) => s + st.durationMs, 0);
    expect(ev.totalDurationMs).toBeGreaterThanOrEqual(sum);

    const parsed = ValidatedTaskCompletedEventSchema.safeParse(ev);
    if (!parsed.success) {
      const r4Issue = parsed.error.issues.find(i => i.message.startsWith('R4:'));
      expect(r4Issue).toBeUndefined();
    }
  });

  it('R4 holds when salvage-promotion inflates a single stage beyond runResult.durationMs', () => {
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
    const sum = ev.stages.reduce((s, st) => s + st.durationMs, 0);
    expect(ev.totalDurationMs).toBeGreaterThanOrEqual(sum);

    // Individual stage durations should never exceed the total
    for (const st of ev.stages) {
      expect(st.durationMs).toBeLessThanOrEqual(ev.totalDurationMs);
    }

    const parsed = ValidatedTaskCompletedEventSchema.safeParse(ev);
    if (!parsed.success) {
      const r4Issue = parsed.error.issues.find(i => i.message.startsWith('R4:'));
      expect(r4Issue).toBeUndefined();
    }
  });
});
