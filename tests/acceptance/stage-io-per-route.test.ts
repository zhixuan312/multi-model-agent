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
const EXPECTED_APPLICABILITY: Record<string, RouteName[]> = {
  prepare:           ['delegate', 'execute-plan', 'audit', 'review', 'debug', 'investigate', 'explore'],
  'register-block':  [],                                                                  // register-context-block ONLY (not in ROUTES)
  implement:         ['delegate', 'execute-plan', 'audit', 'review', 'debug', 'investigate', 'explore'],
  review:            ['delegate', 'execute-plan'],
  rework:            ['delegate', 'execute-plan'],
  commit:            ['delegate', 'execute-plan'],
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

describe('AC-18: Layer-2 shouldRun decisions for representative stages', () => {
  const review = STAGE_PLAN.find((s) => (s as StageDefinition).name === 'review') as StageDefinition;
  const rework = STAGE_PLAN.find((s) => (s as StageDefinition).name === 'rework') as StageDefinition;
  const commit = STAGE_PLAN.find((s) => (s as StageDefinition).name === 'commit') as StageDefinition;

  it('review.shouldRun returns false when implement gate did not advance', () => {
    const state = { gates: {}, reviewPolicy: 'full' } as unknown as LifecycleState;
    const d = review.shouldRun(state);
    expect(d.run).toBe(false);
  });

  it('review.shouldRun returns false when reviewPolicy=none', () => {
    const state = {
      gates: { implement: { outcome: 'advance', payload: {}, telemetry: { stageLabel: 'implement', durationMs: 0, costUSD: 0, turnsUsed: 0, stopReason: 'normal' } } },
      reviewPolicy: 'none',
    } as unknown as LifecycleState;
    const d = review.shouldRun(state);
    expect(d.run).toBe(false);
  });

  it('rework.shouldRun returns false when review approved', () => {
    const state = {
      gates: {
        review: {
          outcome: 'advance',
          payload: { verdict: 'approved' },
          telemetry: { stageLabel: 'review', durationMs: 0, costUSD: 0, turnsUsed: 0, stopReason: 'normal' },
        },
      },
    } as unknown as LifecycleState;
    const d = rework.shouldRun(state);
    expect(d.run).toBe(false);
  });

  it('commit.shouldRun returns false when no files changed', () => {
    const state = { gates: {} } as unknown as LifecycleState;
    const d = commit.shouldRun(state);
    expect(d.run).toBe(false);
  });
});
