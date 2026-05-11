import { describe, it, expect } from 'vitest';
import { buildStagePlan } from '../../packages/core/src/lifecycle/stage-plan-builder.js';

describe('stage plan — pipeline redesign (artifact_producing)', () => {
  it('includes new rows: review, rework, annotate_completion', () => {
    const plan = buildStagePlan('artifact_producing');
    const names = plan.rows.map(r => r.stageName);
    expect(names).toContain('review');
    expect(names).toContain('rework');
    expect(names).toContain('annotate_completion');
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
  });

  it('git_commit gate uses commitGatePercent threshold', () => {
    const plan = buildStagePlan('artifact_producing');
    const commit = plan.rows.find(r => r.stageName === 'git_commit')!;
    // Above threshold + files written → fire
    expect(commit.runCondition({
      autoCommit: true,
      lastRunResult: { filesWritten: ['x.ts'] },
      readOnlyTask: false,
      terminal: false,
      commitGatePercent: 85,
      completionThreshold: 80,
    } as never)).toBe(true);
    // Below threshold → block
    expect(commit.runCondition({
      autoCommit: true,
      lastRunResult: { filesWritten: ['x.ts'] },
      readOnlyTask: false,
      terminal: false,
      commitGatePercent: 65,
      completionThreshold: 80,
    } as never)).toBe(false);
    // No files written → block
    expect(commit.runCondition({
      autoCommit: true,
      lastRunResult: { filesWritten: [] },
      readOnlyTask: false,
      terminal: false,
      commitGatePercent: 100,
      completionThreshold: 80,
    } as never)).toBe(false);
  });

  it("'none' path: commit unconditional on writes via deriveBypassCommitPercent", () => {
    const plan = buildStagePlan('artifact_producing');
    const commit = plan.rows.find(r => r.stageName === 'git_commit')!;
    // reviewPolicy='none' + filesWritten>0 → bypass returns 100 → fires
    expect(commit.runCondition({
      autoCommit: true,
      lastRunResult: { filesWritten: ['x.ts'] },
      readOnlyTask: false,
      terminal: false,
      reviewPolicy: 'none',
      completionThreshold: 80,
    } as never)).toBe(true);
    // reviewPolicy='none' + no files → bypass returns 0 → blocked
    expect(commit.runCondition({
      autoCommit: true,
      lastRunResult: { filesWritten: [] },
      readOnlyTask: false,
      terminal: false,
      reviewPolicy: 'none',
      completionThreshold: 80,
    } as never)).toBe(false);
  });

  it('per-policy gates: review runs for !none; rework only when changes_required; annotate for !none', () => {
    const plan = buildStagePlan('artifact_producing');
    const review = plan.rows.find(r => r.stageName === 'review')!;
    const rework = plan.rows.find(r => r.stageName === 'rework')!;
    const annotate = plan.rows.find(r => r.stageName === 'annotate_completion')!;

    const policies = ['full', 'quality_only', 'diff_only', 'none'] as const;
    const expectedReview = { full: true, quality_only: true, diff_only: true, none: false } as const;

    for (const p of policies) {
      const baseState = { reviewPolicy: p, terminal: false } as never;
      expect(review.runCondition(baseState)).toBe(expectedReview[p]);
      expect(annotate.runCondition(baseState)).toBe(expectedReview[p]);
    }

    const reworkApproved = { reviewPolicy: 'full', reviewVerdict: 'approved', terminal: false } as never;
    const reworkRequired = { reviewPolicy: 'full', reviewVerdict: 'changes_required', terminal: false } as never;
    expect(rework.runCondition(reworkApproved)).toBe(false);
    expect(rework.runCondition(reworkRequired)).toBe(true);
  });
});
