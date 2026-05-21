import { describe, it, expect } from 'vitest';
import { applyAnnotatePreconditions } from '../../packages/core/src/lifecycle/annotate-parser.js';

// Mirror the review verdict/findings into the review gate payload — the
// reviewPayload accessor (and thus the completion gate) reads gates.review.payload.
function withReviewGate(s: any) {
  if (s.reviewVerdict !== undefined && !s.gates?.review) {
    s.gates = { ...(s.gates ?? {}), review: { outcome: 'advance', payload: { verdict: s.reviewVerdict, findings: s.reviewFindings ?? [] } } };
  }
  return s;
}

function baseState(overrides: any = {}) {
  return withReviewGate({
    route: 'delegate',
    reviewPolicy: 'full',
    gates: {
      implement: { outcome: 'advance' },
      commit: { payload: { kind: 'committed' } },
    },
    reviewVerdict: 'approved',
    reworkApplied: undefined,
    reworkError: undefined,
    unaddressedFindingIds: [],
    lastRunResult: { workerStatus: 'done', criteriaSucceeded: [] },
    ...overrides,
  });
}

describe('annotate-parser — deterministic gate (workerStatus no longer load-bearing)', () => {
  it('worker self-assess "failed" with review approved + commit landed → completed=true', () => {
    const proposed: any = { completed: true, message: 'ok', findings: [] };
    const r = applyAnnotatePreconditions(proposed, baseState({
      lastRunResult: { workerStatus: 'failed', criteriaSucceeded: [] },
    }));
    expect(r.completed).toBe(true);
  });

  it('worker self-assess null → still completed=true when objective signals agree', () => {
    const proposed: any = { completed: true, message: 'ok', findings: [] };
    const r = applyAnnotatePreconditions(proposed, baseState({
      lastRunResult: { workerStatus: null, criteriaSucceeded: [] },
    }));
    expect(r.completed).toBe(true);
  });

  it('reviewVerdict=changes_required without rework → completed=false (legit failure)', () => {
    const proposed: any = { completed: true, message: 'ok', findings: [] };
    const r = applyAnnotatePreconditions(proposed, baseState({
      reviewVerdict: 'changes_required',
      reworkApplied: false,
    }));
    expect(r.completed).toBe(false);
    expect(r.message).toMatch(/review/i);
  });

  it('commit gate missing → completed=false', () => {
    const proposed: any = { completed: true, message: 'ok', findings: [] };
    const r = applyAnnotatePreconditions(proposed, baseState({
      gates: { implement: { outcome: 'advance' }, commit: undefined },
    }));
    expect(r.completed).toBe(false);
    expect(r.message).toMatch(/commit/i);
  });
});
