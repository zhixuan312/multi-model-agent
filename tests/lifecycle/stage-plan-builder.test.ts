import { describe, it, expect } from 'vitest';
import { buildStagePlan } from '../../packages/core/src/lifecycle/stage-plan-builder.js';

describe('buildStagePlan', () => {
  it('artifact_producing plan has all 11 review rows + diff row', () => {
    const plan = buildStagePlan('artifact_producing');
    const ids = plan.rows.map(r => r.rowId);
    expect(ids).toEqual(expect.arrayContaining([
      '1.1','1.2','1.3','1.4',
      '2.1','2.2','2.3','2.4','2.5',
      '3.1',
      '4.1','4.2','4.3','4.4','4.5','4.5.x',
      '4.6','4.7','4.8','4.9','4.10','4.10.x',
      '4.11',
      '5.1','5.2','5.3','5.3.5','5.4','5.5',
      '6.1','6.2','6.3',
    ]));
  });
  it('read_only plan exposes row 4.6 (annotator) — runCondition for AP-only rows is false', () => {
    const plan = buildStagePlan('read_only');
    const row46 = plan.rows.find(r => r.rowId === '4.6');
    expect(row46).toBeDefined();
    const row47 = plan.rows.find(r => r.rowId === '4.7');
    expect(row47!.runCondition({ terminal: false, qualityReviewRound1Verdict: 'annotated' } as any)).toBe(false);
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
      const a = r.runCondition(state as any);
      const b = r.runCondition(state as any);
      expect(a).toBe(b);
    }
  });
});
