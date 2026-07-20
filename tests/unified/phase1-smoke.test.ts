import { describe, it, expect } from 'vitest';
import {
  getTypeConfig, oppositeAgent, taskInputSchema, parseReviewerOutput, TASK_TYPES,
} from '../../packages/core/src/index.js';

describe('barrel export smoke', () => {
  it('core/index.js re-exports all unified API symbols', () => {
    expect(typeof getTypeConfig).toBe('function');
    expect(typeof oppositeAgent).toBe('function');
    expect(typeof taskInputSchema.safeParse).toBe('function');
    expect(typeof parseReviewerOutput).toBe('function');
    expect(Array.isArray(TASK_TYPES)).toBe(true);
    expect(TASK_TYPES.length).toBe(12);
  });
});
