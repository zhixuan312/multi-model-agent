import { describe, it, expect } from 'vitest';
import { buildTaskCompletedEvent } from '../../packages/core/src/telemetry/event-builder.js';
import {
  TaskCompletedEventSchema,
  ValidatedTaskCompletedEventSchema,
} from '../../packages/core/src/telemetry/types.js';

function extractWarnings(event: Record<string, unknown>): Array<{ rule: string; path: string }> {
  const warningsMap = new Map<string, { rule: string; path: string }>();

  const baseParsed = TaskCompletedEventSchema.safeParse(event);
  if (!baseParsed.success) {
    for (const i of baseParsed.error.issues) {
      const key = `${i.message}::${i.path.join('.')}`;
      warningsMap.set(key, { rule: i.message, path: i.path.join('.') });
    }
  }

  const refined = ValidatedTaskCompletedEventSchema.safeParse(event);
  if (!refined.success) {
    for (const i of refined.error.issues) {
      const key = `${i.message}::${i.path.join('.')}`;
      warningsMap.set(key, { rule: i.message, path: i.path.join('.') });
    }
  }

  return [...warningsMap.values()];
}

function makeHealthyContext(): any {
  return {
    route: 'delegate' as const,
    taskSpec: { filePaths: [] },
    runResult: {
      status: 'ok',
      durationMs: 50000,
      workerStatus: 'done',
      usage: { inputTokens: 1000, outputTokens: 200, costUSD: 0.05 },
      models: { implementer: 'gpt-5', specReviewer: 'claude-sonnet', qualityReviewer: 'claude-sonnet' },
      agents: { implementer: 'standard' as const, implementerToolMode: 'full' as const, implementerCapabilities: [] as string[] },
      stageStats: {
        implementing: { stage: 'implementing', entered: true, durationMs: 30000, costUSD: 0.03, agentTier: 'standard', modelFamily: 'openai', model: 'gpt-5', maxIdleMs: 1000, totalIdleMs: 5000, activityEvents: 20, inputTokens: 500, outputTokens: 100, cachedTokens: 50, reasoningTokens: 25, turnCount: 7, toolCallCount: 4, filesReadCount: 2, filesWrittenCount: 1 },
        committing: { stage: 'committing', entered: true, durationMs: 500, costUSD: 0.001, agentTier: 'standard', modelFamily: 'openai', model: 'gpt-5', maxIdleMs: 50, totalIdleMs: 100, activityEvents: 1, inputTokens: 100, outputTokens: 50, cachedTokens: 10, reasoningTokens: 5, turnCount: 1, toolCallCount: 1, filesReadCount: 1, filesWrittenCount: 1 },
      },
      terminationReason: { cause: 'finished' as const, turnsUsed: 14, hasFileArtifacts: true, usedShell: false, workerSelfAssessment: 'done' as const, wasPromoted: false },
      commits: [],
      concerns: [],
      escalationLog: [],
    } as any,
    client: 'test',
    parentModel: null,
  };
}

function makeR1ViolatingContext(): any {
  const ctx = makeHealthyContext();
  // R1: terminalStatus=ok requires workerStatus done|done_with_concerns,
  // but workerSelfAssessment 'blocked' produces workerStatus=blocked
  // while terminationReason.cause='finished' produces terminalStatus=ok.
  ctx.runResult.terminationReason.workerSelfAssessment = 'blocked' as any;
  return ctx;
}

describe('Item 13: validation_warnings attached to event', () => {
  it('R1 violation event ships with validation_warnings populated', () => {
    const ctx = makeR1ViolatingContext();
    const event = buildTaskCompletedEvent(ctx);
    const warnings = extractWarnings(event as any);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w) => w.rule.startsWith('R1:'))).toBe(true);
  });

  it('healthy event has validation_warnings absent', () => {
    const ctx = makeHealthyContext();
    const event = buildTaskCompletedEvent(ctx);
    const warnings = extractWarnings(event as any);
    expect(warnings.length).toBe(0);
  });
});
