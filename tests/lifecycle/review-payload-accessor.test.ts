import { describe, it, expect } from 'vitest';
import { reviewPayload } from '../../packages/core/src/lifecycle/stage-plan-types.js';
import type { LifecycleState } from '../../packages/core/src/lifecycle/stage-plan-types.js';

function stateWithReviewGate(payload: unknown): LifecycleState {
  return {
    gates: {
      review: {
        outcome: 'advance',
        payload,
        telemetry: { stageLabel: 'review', durationMs: 0, costUSD: 0, turnsUsed: 0, stopReason: 'normal' },
      },
    },
  } as unknown as LifecycleState;
}

describe('reviewPayload accessor', () => {
  it('maps a full finding to {source,text} with claim/evidence/fix', () => {
    const state = stateWithReviewGate({
      verdict: 'changes_required',
      findings: [{ id: 'F1', severity: 'high', category: 'correctness', claim: 'C', evidence: 'E', suggestion: 'S', source: 'quality' }],
      reviewersSucceeded: ['quality'],
      reviewersErrored: [],
      findingsOutcome: 'found',
    });
    expect(reviewPayload(state)).toEqual({
      verdict: 'changes_required',
      findings: [{ source: 'quality', text: 'C (evidence: E) (fix: S)' }],
    });
  });

  it('falls back to f.text and source "reviewer" for a sparse finding', () => {
    const state = stateWithReviewGate({
      verdict: 'approved',
      findings: [{ text: 'T' }],
      reviewersSucceeded: ['spec'],
      reviewersErrored: [],
      findingsOutcome: 'clean',
    });
    expect(reviewPayload(state)).toEqual({
      verdict: 'approved',
      findings: [{ source: 'reviewer', text: 'T' }],
    });
  });

  it('returns {verdict: undefined, findings: []} when the review gate is absent', () => {
    const state = { gates: {} } as unknown as LifecycleState;
    expect(reviewPayload(state)).toEqual({ verdict: undefined, findings: [] });
  });
});
