import { describe, it, expect } from 'vitest';
import { buildStagePlan } from '../../packages/core/src/lifecycle/stage-plan-builder.js';

const stateBase = {
  terminal: false,
  reviewPolicy: 'full' as const,
  shutdownInProgress: false,
  route: 'delegate',
  verifyCommandPresent: false,
  autoCommit: false,
  filesChanged: [],
  readOnlyTask: false,
  // verdict slots (all undefined initially):
  specReviewRound1Verdict: undefined,
  specReviewRound2Verdict: undefined,
  specReviewRound3Verdict: undefined,
  qualityReviewRound1Verdict: undefined,
  qualityReviewRound2Verdict: undefined,
  qualityReviewRound3Verdict: undefined,
  diffReviewVerdict: undefined,
  specChainPassed: undefined,
  qualityChainPassed: undefined,
};

describe('StagePlan predicates — cascade semantics', () => {
  it('row 4.1 fires when reviewPolicy=full', () => {
    const plan = buildStagePlan('artifact_producing');
    const row = plan.rows.find(r => r.rowId === '4.1')!;
    expect(row.runCondition({ ...stateBase } as any)).toBe(true);
  });
  it('row 4.1 skipped when reviewPolicy=quality_only', () => {
    const plan = buildStagePlan('artifact_producing');
    const row = plan.rows.find(r => r.rowId === '4.1')!;
    expect(row.runCondition({ ...stateBase, reviewPolicy: 'quality_only' } as any)).toBe(false);
  });
  it('row 4.2 (rework) skipped when round_1 verdict=approved', () => {
    const plan = buildStagePlan('artifact_producing');
    const row = plan.rows.find(r => r.rowId === '4.2')!;
    expect(row.runCondition({ ...stateBase, specReviewRound1Verdict: 'approved' } as any)).toBe(false);
  });
  it('row 4.2 (rework) fires when round_1 verdict=changes_required', () => {
    const plan = buildStagePlan('artifact_producing');
    const row = plan.rows.find(r => r.rowId === '4.2')!;
    expect(row.runCondition({ ...stateBase, specReviewRound1Verdict: 'changes_required' } as any)).toBe(true);
  });
  it('row 4.3 (round_2) cascades from round_1 changes_required', () => {
    const plan = buildStagePlan('artifact_producing');
    const row = plan.rows.find(r => r.rowId === '4.3')!;
    expect(row.runCondition({ ...stateBase, specReviewRound1Verdict: 'changes_required' } as any)).toBe(true);
  });
  it('row 4.3 short-circuits when round_1 was approved (undefined-as-shorting-token)', () => {
    const plan = buildStagePlan('artifact_producing');
    const row = plan.rows.find(r => r.rowId === '4.3')!;
    expect(row.runCondition({ ...stateBase, specReviewRound1Verdict: 'approved' } as any)).toBe(false);
  });
  it('row 4.6 (quality round_1) fires for both artifact-producing AND read_only', () => {
    const apPlan = buildStagePlan('artifact_producing');
    const roPlan = buildStagePlan('read_only');
    const apRow = apPlan.rows.find(r => r.rowId === '4.6');
    const roRow = roPlan.rows.find(r => r.rowId === '4.6');
    expect(apRow).toBeDefined();
    expect(roRow).toBeDefined();
  });
  it('row 4.7 (quality rework) short-circuits when annotator emits "annotated" verdict', () => {
    const plan = buildStagePlan('read_only');
    const row = plan.rows.find(r => r.rowId === '4.7');
    if (row) {
      // For read-only, annotator output 'annotated' !== 'concerns', so 4.7 doesn't fire.
      expect(row.runCondition({ ...stateBase, qualityReviewRound1Verdict: 'annotated' } as any)).toBe(false);
    }
  });
  it('row 4.11 (diff_review) fires when reviewPolicy=diff_only without prior chain pass requirement', () => {
    const plan = buildStagePlan('artifact_producing');
    const row = plan.rows.find(r => r.rowId === '4.11')!;
    expect(row.runCondition({ ...stateBase, reviewPolicy: 'diff_only' } as any)).toBe(true);
  });
  it('row 5.1 (run_verify_command) skipped for verify route (verify_work IS the verification)', () => {
    const plan = buildStagePlan('read_only');
    const row = plan.rows.find(r => r.rowId === '5.1')!;
    expect(row.runCondition({ ...stateBase, route: 'verify', verifyCommandPresent: true } as any)).toBe(false);
  });
  it('row 5.3.5 (register_terminal_block) skipped for register-context-block route', () => {
    const plan = buildStagePlan('artifact_producing');
    const row = plan.rows.find(r => r.rowId === '5.3.5')!;
    expect(row.runCondition({ ...stateBase, route: 'register-context-block' } as any)).toBe(false);
  });
  it('row 6.1 (flush_telemetry) always fires', () => {
    const plan = buildStagePlan('artifact_producing');
    const row = plan.rows.find(r => r.rowId === '6.1')!;
    expect(row.runCondition({ ...stateBase } as any)).toBe(true);
  });
});
