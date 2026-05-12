import { describe, it, expect } from 'vitest';
import { buildStagePlan } from '../../packages/core/src/lifecycle/stage-plan-builder.js';

describe('buildStagePlan (v4.4.x five-stage pipeline)', () => {
  it('artifact_producing plan has the five v4.4.x rows + finalize rows', () => {
    const plan = buildStagePlan('artifact_producing');
    const ids = plan.rows.map(r => r.rowId);
    expect(ids).toEqual(expect.arrayContaining([
      '1.1','1.2','1.3','1.4',
      '2.1','2.2','2.3','2.4','2.5',
      '3.1','3.5',
      // v4.4.x rows: review, rework, committing, annotating
      '4.1','4.2','4.3','4.4',
      // Finalize rows
      '5.3.rcb','5.3','5.3.5','5.4','5.5','5.6',
      '6.1','6.2','6.3',
    ]));
    // Verify the old chain rows are GONE
    expect(ids).not.toContain('4.5');
    expect(ids).not.toContain('4.5.x');
    expect(ids).not.toContain('4.6');
    expect(ids).not.toContain('4.7');
    expect(ids).not.toContain('4.11');
    expect(ids).not.toContain('5.1');
    expect(ids).not.toContain('5.2');
  });

  it('read_only plan: review + rework + git_commit are gated off; annotating is always-on', () => {
    const plan = buildStagePlan('read_only');
    const review = plan.rows.find(r => r.stageName === 'review');
    const rework = plan.rows.find(r => r.stageName === 'rework');
    const commit = plan.rows.find(r => r.stageName === 'git_commit');
    const annotate = plan.rows.find(r => r.stageName === 'annotating');
    expect(review).toBeDefined();
    expect(rework).toBeDefined();
    expect(commit).toBeDefined();
    expect(annotate).toBeDefined();
    expect(review!.runCondition({ terminal: false, reviewPolicy: 'full' } as never)).toBe(false);
    expect(rework!.runCondition({ terminal: false, reviewPolicy: 'full', reviewVerdict: 'changes_required' } as never)).toBe(false);
    // git_commit gated by readOnlyTask
    expect(commit!.runCondition({ terminal: false, autoCommit: true, readOnlyTask: true, reviewPolicy: 'none' } as never)).toBe(false);
    // Annotating is the unified terminal report builder — always runs unless terminal.
    expect(annotate!.runCondition({ terminal: false, reviewPolicy: 'full' } as never)).toBe(true);
  });

  it('every row has a runCondition that is a function', () => {
    const plan = buildStagePlan('artifact_producing');
    for (const r of plan.rows) {
      expect(typeof r.runCondition).toBe('function');
    }
  });

  it('no row mutates state (predicates are pure)', () => {
    const plan = buildStagePlan('artifact_producing');
    const state = { terminal: false, attemptIndex: 0, attemptBudget: 7, reviewPolicy: 'full' as const, shutdownInProgress: false };
    for (const r of plan.rows) {
      const a = r.runCondition(state as never);
      const b = r.runCondition(state as never);
      expect(a).toBe(b);
    }
  });
});
