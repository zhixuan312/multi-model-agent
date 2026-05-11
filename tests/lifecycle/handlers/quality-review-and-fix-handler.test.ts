import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LifecycleState } from '../../../packages/core/src/lifecycle/stage-plan-types.js';

vi.mock('../../../packages/core/src/escalation/delegate-with-escalation.js', () => ({
  delegateWithEscalation: vi.fn(),
}));
import { delegateWithEscalation } from '../../../packages/core/src/escalation/delegate-with-escalation.js';
import { qualityReviewAndFixHandler } from '../../../packages/core/src/lifecycle/handlers/quality-review-and-fix-handler.js';

beforeEach(() => {
  vi.mocked(delegateWithEscalation).mockReset();
});

function baseState(): LifecycleState {
  return {
    task: { prompt: 'do work', cwd: '/tmp', agentType: 'standard' },
    lastRunResult: {
      output: 'after spec review',
      status: 'ok',
      filesWritten: ['by-worker.ts', 'fixed-by-spec.ts'],
      filesRead: [],
      toolCalls: [],
    },
    diffTracker: { cumulativeDiff: async () => '@@ +x' },
    executionContext: {
      cwd: '/tmp',
      assignedTier: 'standard',
      providers: {
        standard: { name: 'standard', config: { model: 'mock-s' } },
        complex: { name: 'complex', config: { model: 'mock-c' } },
      },
      timing: { timeoutMs: 30_000, deadlineMs: Date.now() + 30_000 },
      stall: { controller: new AbortController() },
    },
    reviewPolicy: 'full',
    specReviewerNotes: 'spec ran ok',
  } as unknown as LifecycleState;
}

describe('qualityReviewAndFixHandler', () => {
  it('on success: replaces lastRunResult and records qualityReviewerNotes', async () => {
    vi.mocked(delegateWithEscalation).mockResolvedValueOnce({
      output: 'quality fix',
      status: 'ok',
      filesWritten: ['fixed-by-quality.ts'],
      filesRead: [],
      toolCalls: [],
      escalationLog: [],
    } as unknown as never);
    const state = baseState();
    await qualityReviewAndFixHandler(state);
    const writes = (state.lastRunResult as { filesWritten: string[] }).filesWritten;
    expect(writes).toContain('fixed-by-quality.ts');
    expect(writes).toContain('by-worker.ts');
    expect(state.qualityReviewerNotes).toBe('quality fix');
    expect(state.qualityReviewError).toBeUndefined();
    expect(state.terminal).toBeFalsy();
  });

  it('on provider error: sets qualityReviewError, does NOT set terminal', async () => {
    vi.mocked(delegateWithEscalation).mockRejectedValueOnce(new Error('quality boom'));
    const state = baseState();
    await qualityReviewAndFixHandler(state);
    expect(state.qualityReviewError).toMatch(/quality boom/);
    expect(state.terminal).toBeFalsy();
  });

  it('runs when reviewPolicy is "quality_only"', async () => {
    vi.mocked(delegateWithEscalation).mockResolvedValueOnce({
      output: 'quality fix',
      status: 'ok',
      filesWritten: [],
      filesRead: [],
      toolCalls: [],
      escalationLog: [],
    } as unknown as never);
    const state = baseState();
    state.reviewPolicy = 'quality_only';
    await qualityReviewAndFixHandler(state);
    expect(state.qualityReviewerNotes).toBe('quality fix');
  });

  it('skips when reviewPolicy is "diff_only" or "none"', async () => {
    for (const policy of ['diff_only', 'none'] as const) {
      const state = baseState();
      state.reviewPolicy = policy;
      vi.mocked(delegateWithEscalation).mockReset();
      await qualityReviewAndFixHandler(state);
      expect(vi.mocked(delegateWithEscalation)).not.toHaveBeenCalled();
    }
  });
});
