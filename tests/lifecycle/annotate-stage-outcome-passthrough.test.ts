import { describe, it, expect } from 'bun:test';
import { annotator } from '../../packages/core/src/lifecycle/handlers/annotate-stage.js';

function makeReadRouteState(findingsOutcome: 'found' | 'clean' | 'not_applicable', reason: string | null = null) {
  return {
    route: 'audit',
    gates: {},
    lastRunResult: {
      findings: [],
      summary: 'mock summary',
      workerStatus: 'done',
      findingsOutcome,
      findingsOutcomeReason: reason,
      outcomeInferred: false,
      outcomeMalformed: false,
      criteriaErrors: [],
    },
    executionContext: {},
  } as any;
}

describe('annotator — findingsOutcome pass-through', () => {
  it('copies last.findingsOutcome onto structuredReport.findingsOutcome', async () => {
    const state = makeReadRouteState('clean');
    await annotator(state);
    expect(state.structuredReport.findingsOutcome).toBe('clean');
    expect(state.structuredReport.outcomeInferred).toBe(false);
    expect(state.structuredReport.outcomeMalformed).toBe(false);
  });

  it('copies findingsOutcomeReason when outcome is not_applicable', async () => {
    const state = makeReadRouteState('not_applicable', 'project-level question');
    await annotator(state);
    expect(state.structuredReport.findingsOutcome).toBe('not_applicable');
    expect(state.structuredReport.findingsOutcomeReason).toBe('project-level question');
  });

  it('does NOT compute outcome from findings.length; pass-through only', async () => {
    // Even if findings.length=0, if last.findingsOutcome is missing, structuredReport.findingsOutcome should be undefined (not inferred here).
    const state = makeReadRouteState(undefined as any);
    delete (state.lastRunResult as any).findingsOutcome;
    await annotator(state);
    expect(state.structuredReport.findingsOutcome).toBeUndefined();
  });
});
