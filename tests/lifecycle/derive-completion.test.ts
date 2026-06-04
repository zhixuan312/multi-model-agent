import { describe, it, expect } from 'vitest';
import { deriveCompletion, type CompletionInputs } from '../../packages/core/src/lifecycle/derive-completion.js';

function base(overrides: Partial<CompletionInputs> = {}): CompletionInputs {
  return {
    route: 'delegate',
    implementOutcome: 'advance',
    reviewPolicy: 'full',
    reviewVerdict: undefined,
    reviewSubResults: undefined,
    reworkApplied: undefined,
    reworkError: undefined,
    unaddressedFindingIds: undefined,
    commitKind: undefined,
    criteriaSucceeded: undefined,
    ...overrides,
  };
}

describe('deriveCompletion', () => {
  it('case 1: write route, review approved, commit landed → completed=true', () => {
    const r = deriveCompletion(base({ reviewVerdict: 'approved', commitKind: 'committed' }));
    expect(r.completed).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it('case 2: write route, review approved, commit landed, worker self-assess "failed" → still completed=true', () => {
    // workerSelfAssessment is not even a parameter — proves it cannot affect completion
    const r = deriveCompletion(base({ reviewVerdict: 'approved', commitKind: 'committed' }));
    expect(r.completed).toBe(true);
  });

  it('case 3: write route, review approved, no_op commit → completed=true', () => {
    const r = deriveCompletion(base({ reviewVerdict: 'approved', commitKind: 'no_op' }));
    expect(r.completed).toBe(true);
  });

  it('case 4: write route, review approved, commit missing → completed=false', () => {
    const r = deriveCompletion(base({ reviewVerdict: 'approved', commitKind: undefined }));
    expect(r.completed).toBe(false);
    expect(r.reasons).toContain('commit did not complete');
  });

  it('case 5: write route, changes_required + rework applied + clean + commit → completed=true', () => {
    const r = deriveCompletion(base({
      reviewVerdict: 'changes_required',
      reworkApplied: true,
      reworkError: undefined,
      unaddressedFindingIds: [],
      commitKind: 'committed',
    }));
    expect(r.completed).toBe(true);
  });

  it('case 6: write route, changes_required + rework applied + unaddressed findings → completed=false', () => {
    const r = deriveCompletion(base({
      reviewVerdict: 'changes_required',
      reworkApplied: true,
      unaddressedFindingIds: ['F1', 'F2'],
      commitKind: 'committed',
    }));
    expect(r.completed).toBe(false);
    expect(r.reasons).toContain('review did not pass');
  });

  it('case 7: write route, changes_required + rework not applied → completed=false', () => {
    const r = deriveCompletion(base({
      reviewVerdict: 'changes_required',
      reworkApplied: false,
      commitKind: 'committed',
    }));
    expect(r.completed).toBe(false);
  });

  it('case 8: implement did not advance → completed=false regardless', () => {
    const r = deriveCompletion(base({
      implementOutcome: 'fail',
      reviewVerdict: 'approved',
      commitKind: 'committed',
    }));
    expect(r.completed).toBe(false);
    expect(r.reasons).toContain('implement did not advance');
  });

  it('case 9: write route, reviewPolicy=none + commit landed → completed=true', () => {
    const r = deriveCompletion(base({
      reviewPolicy: 'none',
      commitKind: 'committed',
    }));
    expect(r.completed).toBe(true);
  });

  it('case 10: write route, review approved + commit missing → completed=false', () => {
    const r = deriveCompletion(base({
      reviewVerdict: 'approved',
      commitKind: undefined,
    }));
    expect(r.completed).toBe(false);
    expect(r.reasons).toContain('commit did not complete');
  });

  it('case 11: read route (investigate), criteriaSucceeded non-empty → completed=true', () => {
    const r = deriveCompletion(base({
      route: 'investigate',
      criteriaSucceeded: ['c1'],
    }));
    expect(r.completed).toBe(true);
  });

  it('case 12: read route, criteriaSucceeded empty → completed=false', () => {
    const r = deriveCompletion(base({
      route: 'investigate',
      criteriaSucceeded: [],
    }));
    expect(r.completed).toBe(false);
    expect(r.reasons).toContain('no successful criteria');
  });

  it('case 13: read route (explore), criteriaSucceeded non-empty → completed=true', () => {
    const r = deriveCompletion(base({
      route: 'explore',
      criteriaSucceeded: ['c1'],
    }));
    expect(r.completed).toBe(true);
  });
});
