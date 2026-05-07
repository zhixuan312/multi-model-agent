import { describe, it, expect } from 'vitest';
import { EscalationPolicy } from '../../packages/core/src/escalation/escalation-policy.js';

describe('EscalationPolicy', () => {
  const p = new EscalationPolicy();

  it('caller tier holds for attempts 0 and 1 (per spec C9)', () => {
    expect(p.rotateImpl('standard', 0)).toBe('standard');
    expect(p.rotateImpl('standard', 1)).toBe('standard');
    expect(p.rotateImpl('complex', 0)).toBe('complex');
    expect(p.rotateImpl('complex', 1)).toBe('complex');
  });

  it('rotation fires at attempt 2 (the 3rd try)', () => {
    expect(p.rotateImpl('standard', 2)).toBe('complex');
    expect(p.rotateImpl('complex', 2)).toBe('standard');
  });

  it('throws when attempt budget exhausted', () => {
    expect(() => p.rotateImpl('standard', 3)).toThrow(/budget exhausted/);
  });

  it('reviewer flips to other tier from current implementer (auto-flip on attempt 2)', () => {
    // Attempt 0: impl=standard, reviewer=complex
    expect(p.rotateReviewer(p.rotateImpl('standard', 0))).toBe('complex');
    // Attempt 2: impl rotated to complex, reviewer auto-flips to standard
    expect(p.rotateReviewer(p.rotateImpl('standard', 2))).toBe('standard');
  });

  it('attempt budgets per category', () => {
    expect(p.attemptBudget('artifact_producing')).toBe(7);
    expect(p.attemptBudget('read_only')).toBe(2);
    expect(p.attemptBudget('research')).toBe(3);
  });
});
