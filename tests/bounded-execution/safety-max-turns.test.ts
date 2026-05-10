import { describe, it, expect } from 'vitest';
import { SAFETY_MAX_TURNS } from '../../packages/core/src/bounded-execution/safety-max-turns.js';

describe('SAFETY_MAX_TURNS', () => {
  it('exports a positive integer at the documented value (200)', () => {
    expect(SAFETY_MAX_TURNS).toBe(200);
    expect(Number.isInteger(SAFETY_MAX_TURNS)).toBe(true);
    expect(SAFETY_MAX_TURNS).toBeGreaterThan(0);
  });
});
