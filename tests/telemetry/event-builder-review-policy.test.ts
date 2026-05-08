import { describe, it, expect } from 'vitest';
import { buildTaskCompletedEvent } from '../../packages/core/src/events/event-builder.js';

/**
 * Gap 15 (4.0.3+): per-task reviewPolicy must reach the wire so the
 * recorded telemetry reflects what the lifecycle actually ran. Pre-fix,
 * BuildContext omitted reviewPolicy → event-builder always fell back to
 * the route default ('full' for delegate, 'quality_only' for read-only),
 * masking the lifecycle's per-task overrides.
 */
describe('event-builder reviewPolicy threading (Gap 15)', () => {
  const baseRunResult = {
    durationMs: 1000,
    stageStats: {
      implementing: {
        stage: 'implementing', entered: true, durationMs: 1000, costUSD: 0.01,
        agentTier: 'standard', modelFamily: 'claude', model: 'claude-sonnet',
        inputTokens: 100, outputTokens: 50, cachedReadTokens: 0, cachedNonReadTokens: 0,
        turnCount: 1, toolCallCount: 1,
      },
    },
    terminationReason: { cause: 'finished', turnsUsed: 1, hasFileArtifacts: true, usedShell: false, workerSelfAssessment: 'done', wasPromoted: false },
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUSD: 0.01 },
  } as any;

  it('per-task reviewPolicy=none wins over delegate route default (full)', () => {
    const ev = buildTaskCompletedEvent({
      route: 'delegate',
      taskSpec: {},
      runResult: baseRunResult,
      client: 'claude-code',
      mainModel: null,
      reviewPolicy: 'none',
    } as any);
    expect(ev.reviewPolicy).toBe('none');
  });

  it('per-task reviewPolicy=quality_only wins over delegate route default', () => {
    const ev = buildTaskCompletedEvent({
      route: 'delegate',
      taskSpec: {},
      runResult: baseRunResult,
      client: 'claude-code',
      mainModel: null,
      reviewPolicy: 'quality_only',
    } as any);
    expect(ev.reviewPolicy).toBe('quality_only');
  });

  it('falls back to route default when ctx.reviewPolicy is undefined (delegate → full)', () => {
    const ev = buildTaskCompletedEvent({
      route: 'delegate',
      taskSpec: {},
      runResult: baseRunResult,
      client: 'claude-code',
      mainModel: null,
    } as any);
    expect(ev.reviewPolicy).toBe('full');
  });

  it('falls back to route default for read-only routes (audit → quality_only)', () => {
    const ev = buildTaskCompletedEvent({
      route: 'audit',
      taskSpec: {},
      runResult: baseRunResult,
      client: 'claude-code',
      mainModel: null,
    } as any);
    expect(ev.reviewPolicy).toBe('quality_only');
  });
});
