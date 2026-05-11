import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LifecycleState } from '../../../packages/core/src/lifecycle/stage-plan-types.js';

vi.mock('../../../packages/core/src/escalation/delegate-with-escalation.js', () => ({
  delegateWithEscalation: vi.fn(),
}));
import { delegateWithEscalation } from '../../../packages/core/src/escalation/delegate-with-escalation.js';
import { specReviewAndFixHandler } from '../../../packages/core/src/lifecycle/handlers/spec-review-and-fix-handler.js';

beforeEach(() => {
  vi.mocked(delegateWithEscalation).mockReset();
});

function baseState(): LifecycleState {
  return {
    task: { prompt: 'do work', cwd: '/tmp', agentType: 'standard' },
    lastRunResult: {
      output: 'worker said done',
      status: 'ok',
      filesWritten: ['by-worker.ts'],
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
  } as unknown as LifecycleState;
}

describe('specReviewAndFixHandler', () => {
  it('on success: replaces lastRunResult and records specReviewerNotes', async () => {
    vi.mocked(delegateWithEscalation).mockResolvedValueOnce({
      output: 'fixed it',
      status: 'ok',
      filesWritten: ['fixed-by-reviewer.ts'],
      filesRead: [],
      toolCalls: [],
      escalationLog: [],
    } as unknown as never);
    const state = baseState();
    await specReviewAndFixHandler(state);
    const writes = (state.lastRunResult as { filesWritten: string[] }).filesWritten;
    expect(writes).toContain('fixed-by-reviewer.ts');
    expect(writes).toContain('by-worker.ts');
    expect(state.specReviewerNotes).toBe('fixed it');
    expect(state.specReviewError).toBeUndefined();
    expect(state.terminal).toBeFalsy();
  });

  it('on provider error: leaves lastRunResult unchanged, sets specReviewError, does NOT set terminal', async () => {
    vi.mocked(delegateWithEscalation).mockRejectedValueOnce(new Error('transport boom'));
    const state = baseState();
    await specReviewAndFixHandler(state);
    const writes = (state.lastRunResult as { filesWritten: string[] }).filesWritten;
    expect(writes).toEqual(['by-worker.ts']);
    expect(state.specReviewError).toMatch(/transport boom/);
    expect(state.specReviewerNotes).toBeUndefined();
    expect(state.terminal).toBeFalsy();
  });

  it('skips when reviewPolicy is not "full"', async () => {
    const state = baseState();
    state.reviewPolicy = 'quality_only';
    await specReviewAndFixHandler(state);
    expect(vi.mocked(delegateWithEscalation)).not.toHaveBeenCalled();
    expect(state.specReviewerNotes).toBeUndefined();
  });

  it('idempotent: skips when already run', async () => {
    const state = baseState();
    state.specReviewerNotes = 'previously fixed';
    await specReviewAndFixHandler(state);
    expect(vi.mocked(delegateWithEscalation)).not.toHaveBeenCalled();
  });
});
