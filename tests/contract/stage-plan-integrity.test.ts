// v5 STAGE_PLAN integrity invariants. Replaces the legacy row-based test
// that asserted on buildStagePlan(category).rows; the v5 plan is a flat
// StageDefinition[] and the invariants we care about are stage-name
// uniqueness, handler-is-function, and shouldRun purity.

import { describe, it, expect } from 'bun:test';
import { STAGE_PLAN } from '../../packages/core/src/lifecycle/stage-plan-builder.js';
import type { StageDefinition } from '../../packages/core/src/lifecycle/stage-io.js';
import type { LifecycleState } from '../../packages/core/src/lifecycle/stage-plan-types.js';

describe('STAGE_PLAN integrity (v5)', () => {
  it('every stage has a function handler and shouldRun', () => {
    for (const stage of STAGE_PLAN) {
      const def = stage as StageDefinition;
      expect(typeof def.handler).toBe('function');
      expect(typeof def.shouldRun).toBe('function');
    }
  });

  it('shouldRun is deterministic on a fixed state', () => {
    const state: LifecycleState = {
      terminal: false,
      reviewPolicy: 'full',
      shutdownInProgress: false,
      route: 'delegate',
      gates: {},
      halted: false,
    } as unknown as LifecycleState;
    for (const stage of STAGE_PLAN) {
      const def = stage as StageDefinition;
      const a = def.shouldRun(state);
      const b = def.shouldRun(state);
      expect(a.run).toBe(b.run);
    }
  });

  it('stage names are unique', () => {
    const names = STAGE_PLAN.map((s) => (s as StageDefinition).name);
    expect(new Set(names).size).toBe(names.length);
  });
});
