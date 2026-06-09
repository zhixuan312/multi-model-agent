import { describe, it, expect } from 'vitest';
import { STAGE_PLAN } from '../../packages/core/src/lifecycle/stage-plan-builder.js';
import type { LifecycleState } from '../../packages/core/src/lifecycle/stage-plan-types.js';

const review = STAGE_PLAN.find((s) => s.name === 'review')!;

// Goal mode: the review stage is the phase-2 review-fix pass. It runs only when
// implement advanced AND the task carries a goal AND reviewPolicy != none.
const goalStub = { goal: { tasks: [{ n: 1 }], phases: [{ tier: 'standard' }, { tier: 'complex' }] } };

describe('review (review-fix) stage skip reason', () => {
  it('returns skipReason "reviewPolicy_none" when reviewPolicy is none', () => {
    const state = {
      reviewPolicy: 'none',
      task: goalStub,
      gates: { implement: { outcome: 'advance' } },
    } as unknown as LifecycleState;
    const d = review.shouldRun(state);
    expect(d.run).toBe(false);
    expect((d as { skipReason?: string }).skipReason).toBe('reviewPolicy_none');
  });

  it('does NOT set the reviewPolicy_none skipReason for the implement-not-advanced skip', () => {
    const state = {
      reviewPolicy: 'full',
      task: goalStub,
      gates: { implement: { outcome: 'skip' } },
    } as unknown as LifecycleState;
    const d = review.shouldRun(state);
    expect(d.run).toBe(false);
    expect((d as { skipReason?: string }).skipReason).toBeUndefined();
  });
});
