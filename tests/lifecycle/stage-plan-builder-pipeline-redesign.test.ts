import { describe, it, expect } from 'vitest';
import { buildStagePlan } from '../../packages/core/src/lifecycle/stage-plan-builder.js';

describe('stage plan — v4.4.x five-stage pipeline (artifact_producing)', () => {
  it('includes new rows: review, rework, git_commit, annotating', () => {
    const plan = buildStagePlan('artifact_producing');
    const names = plan.rows.map(r => r.stageName);
    expect(names).toContain('review');
    expect(names).toContain('rework');
    expect(names).toContain('git_commit');
    expect(names).toContain('annotating');
  });

  it('removes old chain rows', () => {
    const plan = buildStagePlan('artifact_producing');
    const names = plan.rows.map(r => r.stageName);
    expect(names).not.toContain('spec_review_round_1');
    expect(names).not.toContain('rework_for_spec_round_1');
    expect(names).not.toContain('quality_review_round_1');
    expect(names).not.toContain('settle_spec_chain');
    expect(names).not.toContain('settle_quality_chain');
    expect(names).not.toContain('run_verify_command');
    expect(names).not.toContain('review_diff');
    expect(names).not.toContain('annotate_completion');
    expect(names).not.toContain('annotate_criteria');
  });

  it('git_commit fires on approved review or no review (and only for write tasks)', () => {
    const plan = buildStagePlan('artifact_producing');
    const commit = plan.rows.find(r => r.stageName === 'git_commit')!;
    // approved review → fire
    expect(commit.runCondition({
      autoCommit: true, readOnlyTask: false, terminal: false,
      reviewPolicy: 'full', reviewVerdict: 'approved',
    } as never)).toBe(true);
    // changes_required → block
    expect(commit.runCondition({
      autoCommit: true, readOnlyTask: false, terminal: false,
      reviewPolicy: 'full', reviewVerdict: 'changes_required',
    } as never)).toBe(false);
    // no review (policy === 'none') → fire
    expect(commit.runCondition({
      autoCommit: true, readOnlyTask: false, terminal: false,
      reviewPolicy: 'none',
    } as never)).toBe(true);
    // autoCommit off → block
    expect(commit.runCondition({
      autoCommit: false, readOnlyTask: false, terminal: false,
      reviewPolicy: 'none',
    } as never)).toBe(false);
    // read-only task → block
    expect(commit.runCondition({
      autoCommit: true, readOnlyTask: true, terminal: false,
      reviewPolicy: 'none',
    } as never)).toBe(false);
  });

  it('per-policy gates: review runs for !none; rework only when changes_required; annotating always (non-terminal)', () => {
    const plan = buildStagePlan('artifact_producing');
    const review = plan.rows.find(r => r.stageName === 'review')!;
    const rework = plan.rows.find(r => r.stageName === 'rework')!;
    const annotate = plan.rows.find(r => r.stageName === 'annotating')!;

    const policies = ['full', 'quality_only', 'diff_only', 'none'] as const;
    const expectedReview = { full: true, quality_only: true, diff_only: true, none: false } as const;

    for (const p of policies) {
      const baseState = { reviewPolicy: p, terminal: false } as never;
      expect(review.runCondition(baseState)).toBe(expectedReview[p]);
      // Annotating is the unified terminal report builder — always runs unless terminal.
      expect(annotate.runCondition(baseState)).toBe(true);
    }
    // Terminal blocks annotating.
    expect(annotate.runCondition({ reviewPolicy: 'full', terminal: true } as never)).toBe(false);

    const reworkApproved = { reviewPolicy: 'full', reviewVerdict: 'approved', terminal: false } as never;
    const reworkRequired = { reviewPolicy: 'full', reviewVerdict: 'changes_required', terminal: false } as never;
    expect(rework.runCondition(reworkApproved)).toBe(false);
    expect(rework.runCondition(reworkRequired)).toBe(true);
  });
});
