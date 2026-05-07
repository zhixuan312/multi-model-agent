import { describe, it, expect } from 'vitest';
import { buildStagePlan } from '../../packages/core/src/lifecycle/stage-plan-builder.js';

describe('StagePlan integrity', () => {
  it('every row has a function runCondition', () => {
    for (const cat of ['artifact_producing', 'read_only', 'research'] as const) {
      const plan = buildStagePlan(cat);
      for (const row of plan.rows) {
        expect(typeof row.runCondition).toBe('function');
      }
    }
  });

  it('runCondition is pure (deterministic on fixed state)', () => {
    for (const cat of ['artifact_producing', 'read_only', 'research'] as const) {
      const plan = buildStagePlan(cat);
      const state = {
        terminal: false,
        attemptIndex: 0,
        attemptBudget: 7,
        reviewPolicy: 'full' as const,
        shutdownInProgress: false,
      };
      for (const row of plan.rows) {
        const a = row.runCondition(state as any);
        const b = row.runCondition(state as any);
        expect(a).toBe(b);
      }
    }
  });

  it('rowId values are unique', () => {
    for (const cat of ['artifact_producing', 'read_only', 'research'] as const) {
      const plan = buildStagePlan(cat);
      const ids = plan.rows.map((r) => r.rowId);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});
