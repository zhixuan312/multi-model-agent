// tests/lifecycle/annotator-model-stat.test.ts
import { describe, it, expect, vi } from 'bun:test';
import { annotator } from '../../packages/core/src/lifecycle/handlers/annotate-stage.js';
import type { LifecycleState } from '../../packages/core/src/lifecycle/stage-plan-types.js';

// Minimal annotator state factory. Adapt fields based on what annotator()
// actually reads — see lifecycle-context.ts LifecycleState definition.
function makeAnnotatorState(overrides: Partial<LifecycleState> = {}): LifecycleState {
  const baseState = {
    terminal: false,
    reviewPolicy: 'full',
    shutdownInProgress: false,
    route: 'delegate',
    taskSpec: { route: 'delegate', filePaths: [] },
    lastRunResult: {
      summary: 'test',
      findings: [],
      filesChanged: [],
      stageStats: {
        implementing: { entered: true, model: 'claude-haiku-4-5', agentTier: 'standard', costUSD: 0.05, durationMs: 100, turnCount: 1 },
      },
    },
    executionContext: undefined,
  } as unknown as LifecycleState;
  return { ...baseState, ...overrides };
}

describe('annotator handler — stageStats.model population (T9)', () => {
  it('populates stageStats.annotating.model with canonical model id when LLM turn succeeds', async () => {
    const mockSession = {
      send: vi.fn().mockResolvedValue({
        output: JSON.stringify({ completed: true, message: 'ok' }),
        costUSD: 0.01,
        turns: 1,
        model: 'claude-haiku-4-5',
      }),
    };
    const state = makeAnnotatorState({
      executionContext: { getSession: () => mockSession } as any,
    });

    await annotator(state);

    const annotatingStats = (state.lastRunResult as any).stageStats.annotating;
    expect(annotatingStats).toBeDefined();
    expect(annotatingStats.model).toBe('claude-haiku-4-5');
    expect(annotatingStats.agentTier).toBe('standard');
  });

  it('leaves stageStats.annotating.model null when no LLM turn ran (degraded path)', async () => {
    const state = makeAnnotatorState({ executionContext: undefined });

    await annotator(state);

    const annotatingStats = (state.lastRunResult as any).stageStats.annotating;
    // degraded path: tier should be null and model null
    expect(annotatingStats?.model ?? null).toBeNull();
  });
});
