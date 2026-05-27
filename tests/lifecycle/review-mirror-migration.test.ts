// Characterization for the reviewVerdict/reviewFindings mirror migration.
// The rework GATE already reads gates.review.payload directly; the accessor
// reads the same source. These assertions must hold identically before and
// after the hoist + state mirror are removed.
import { describe, it, expect } from 'bun:test';
import { STAGE_PLAN } from '../../packages/core/src/lifecycle/stage-plan-builder.js';
import { reviewPayload } from '../../packages/core/src/lifecycle/stage-plan-types.js';
import type { LifecycleState } from '../../packages/core/src/lifecycle/stage-plan-types.js';

const reworkStage = STAGE_PLAN.find((s) => s.name === 'rework')!;
const finding = { id: 'F1', severity: 'high', category: 'correctness', claim: 'C', evidence: 'E', suggestion: 'S', source: 'reviewer' };

function reviewGate(verdict: 'approved' | 'changes_required', findings: unknown[]) {
  return {
    outcome: 'advance',
    payload: { verdict, findings, reviewersSucceeded: ['quality'], reviewersErrored: [], findingsOutcome: findings.length ? 'found' : 'clean' },
    telemetry: { stageLabel: 'review', durationMs: 0, costUSD: 0, turnsUsed: 0, stopReason: 'normal' },
  };
}

describe('review mirror migration — behavior via gate payload', () => {
  it('(a) rework gate fires when changes_required with findings', () => {
    const s = { reviewPolicy: 'full', gates: { review: reviewGate('changes_required', [finding]) } } as unknown as LifecycleState;
    expect(reworkStage.shouldRun(s).run).toBe(true);
  });
  it('(b) rework gate does not fire when approved', () => {
    const s = { reviewPolicy: 'full', gates: { review: reviewGate('approved', []) } } as unknown as LifecycleState;
    expect(reworkStage.shouldRun(s).run).toBe(false);
  });
  it('(c) rework gate does not fire when review was skipped (absent gate)', () => {
    const s = { reviewPolicy: 'none', gates: {} } as unknown as LifecycleState;
    expect(reworkStage.shouldRun(s).run).toBe(false);
  });
  it('(d) mapped findings match the {source,text} form rework-stage consumes', () => {
    const s = { reviewPolicy: 'full', gates: { review: reviewGate('changes_required', [finding]) } } as unknown as LifecycleState;
    expect(reviewPayload(s).findings).toEqual([{ source: 'reviewer', text: 'C (evidence: E) (fix: S)' }]);
    expect(reviewPayload(s).verdict).toBe('changes_required');
  });
});
