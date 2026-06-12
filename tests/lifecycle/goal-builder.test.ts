import { describe, it, expect } from 'vitest';
import { assembleGoal, goalToTaskSpec } from '../../packages/core/src/lifecycle/goal-builder.js';
import { implementGoalPrompt } from '../../packages/core/src/lifecycle/goal-prompts.js';
import { deriveCompletion } from '../../packages/core/src/lifecycle/derive-completion.js';

const base = {
  source: 'delegate' as const, cwd: '/tmp/x',
  tools: 'full' as const, sandboxPolicy: 'cwd-only' as const,
  phases: [{ tier: 'standard' as const, mode: 'implement' as const }, { tier: 'complex' as const, mode: 'review-fix' as const }],
};

describe('assembleGoal', () => {
  it('numbers tasks 1..N and renders PHASE + [task N] markers', () => {
    const g = assembleGoal({ ...base, reviewPolicy: 'review-fix', tasks: [
      { heading: 'first', body: 'do first', phase: 1 },
      { heading: 'second', body: 'do second', phase: 2 },
    ] });
    expect(g.tasks.map((t) => t.n)).toEqual([1, 2]);
    expect(g.phaseCount).toBe(2);
    expect(g.planText).toContain('PHASE 1:');
    expect(g.planText).toContain('PHASE 2:');
    expect(g.planText).toContain('[task 1] first');
    expect(g.planText).toContain('[task 2] second');
  });

  it("reviewPolicy 'none' collapses phases to phase-1 only, on its configured tier (AC-5)", () => {
    const g = assembleGoal({ ...base, reviewPolicy: 'none',
      phases: [{ tier: 'complex', mode: 'implement' }, { tier: 'complex', mode: 'review-fix' }],
      tasks: [{ heading: 'x', body: 'x', phase: 1 }] });
    expect(g.phases).toHaveLength(1);
    expect(g.phases[0]!.tier).toBe('complex');
    const spec = goalToTaskSpec(g, implementGoalPrompt(g), 1000);
    expect(spec.agentType).toBe('complex');
    expect(spec.reviewPolicy).toBe('none');
    expect(spec.goal).toBe(g);
  });
});

describe('deriveCompletion goal branch', () => {
  const goalInputs = (commits: number) => ({
    route: 'delegate' as const, implementOutcome: 'advance' as const,
    reviewPolicy: 'full' as const, reviewVerdict: undefined, reworkApplied: undefined,
    reworkError: undefined, unaddressedFindingIds: undefined, commitKind: undefined,
    criteriaSucceeded: undefined, goalCommitCount: commits,
  });
  it('completes when >=1 commit landed', () => {
    expect(deriveCompletion(goalInputs(2)).completed).toBe(true);
  });
  it('fails on zero commits (AC-2)', () => {
    const r = deriveCompletion(goalInputs(0));
    expect(r.completed).toBe(false);
    expect(r.reasons).toContain('no commits landed');
  });
});
