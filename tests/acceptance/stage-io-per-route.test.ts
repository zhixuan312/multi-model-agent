// tests/acceptance/stage-io-per-route.test.ts
//
// Covers AC-18 — per-route stage participation matrix. For each route ×
// stage cell in §6, verifies whether the stage is applicable (Layer 1)
// and whether the default `shouldRun` returns true given a base state.

import { describe, it, expect } from 'vitest';
import { STAGE_PLAN } from '../../packages/core/src/lifecycle/stage-plan-builder.js';
import type { StageDefinition, RouteName } from '../../packages/core/src/lifecycle/stage-io.js';
import type { LifecycleState } from '../../packages/core/src/lifecycle/stage-plan-types.js';

const ROUTES: RouteName[] = ['delegate', 'execute-plan', 'audit', 'review', 'debug', 'investigate', 'explore'];

// Spec §6 matrix — values are 'advance' (Layer 1 + Layer 2 default true)
// or 'skip' (Layer 1 rejected, or Layer 2 default false).
//
// We verify Layer-1 applicability for every cell. Layer-2 dynamics require
// more state context and are exercised elsewhere (e.g., review skips when
// reviewPolicy='none' — covered in stage-io-skip-comments.test.ts).
// Goal mode (v5.1): review = phase-2 review-fix (write routes only); rework +
// commit stages removed (the agent self-commits).
const EXPECTED_APPLICABILITY: Record<string, RouteName[]> = {
  prepare:           ['delegate', 'execute-plan', 'audit', 'review', 'debug', 'investigate', 'explore'],
  'register-block':  [],                                                                  // register-context-block ONLY (not in ROUTES)
  implement:         ['delegate', 'execute-plan', 'audit', 'review', 'debug', 'investigate', 'explore'],
  review:            ['delegate', 'execute-plan'],
  annotate:          ['delegate', 'execute-plan', 'audit', 'review', 'debug', 'investigate', 'explore'],
  compose:           ['delegate', 'execute-plan', 'audit', 'review', 'debug', 'investigate', 'explore'],
  terminal:          ['delegate', 'execute-plan', 'audit', 'review', 'debug', 'investigate', 'explore'],
};

function appliesTo(stage: StageDefinition, route: RouteName): boolean {
  if (stage.applicableRoutes === 'all') return true;
  return (stage.applicableRoutes as readonly string[]).includes(route);
}

describe('AC-18: per-route × per-stage participation matrix (Layer 1 only)', () => {
  for (const stage of STAGE_PLAN) {
    const def = stage as StageDefinition;
    const expectedRoutes = EXPECTED_APPLICABILITY[def.name];

    for (const route of ROUTES) {
      const shouldApply = expectedRoutes?.includes(route) ?? false;
      it(`stage=${def.name} × route=${route} → applicable=${shouldApply}`, () => {
        expect(appliesTo(def, route)).toBe(shouldApply);
      });
    }
  }
});

describe('AC-18: Layer-2 shouldRun decisions (review-fix stage)', () => {
  const review = STAGE_PLAN.find((s) => (s as StageDefinition).name === 'review') as StageDefinition;
  const goalStub = { goal: { tasks: [{ n: 1 }], phases: [{ tier: 'standard' }, { tier: 'complex' }] } };

  it('review.shouldRun returns false when implement gate did not advance', () => {
    const state = { gates: {}, reviewPolicy: 'full', task: goalStub } as unknown as LifecycleState;
    expect(review.shouldRun(state).run).toBe(false);
  });

  it('review.shouldRun returns false when the task carries no goal', () => {
    const state = {
      gates: { implement: { outcome: 'advance' } },
      reviewPolicy: 'full',
    } as unknown as LifecycleState;
    expect(review.shouldRun(state).run).toBe(false);
  });

  it('review.shouldRun returns false when reviewPolicy=none', () => {
    const state = {
      gates: { implement: { outcome: 'advance' } },
      reviewPolicy: 'none',
      task: goalStub,
    } as unknown as LifecycleState;
    expect(review.shouldRun(state).run).toBe(false);
  });

  it('review.shouldRun runs when implement advanced, goal present, reviewPolicy != none', () => {
    const state = {
      gates: { implement: { outcome: 'advance' } },
      reviewPolicy: 'full',
      task: goalStub,
    } as unknown as LifecycleState;
    expect(review.shouldRun(state).run).toBe(true);
  });
});
