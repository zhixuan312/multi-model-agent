import { describe, it, expect } from 'vitest';
import { multiModelConfigSchema } from '../../packages/core/src/config/schema.js';

describe('agents.<tier>.model — single-model invariant', () => {

  it('accepts a single string model id', () => {
    const result = multiModelConfigSchema.safeParse({
      agents: {
        standard: { type: 'claude', model: 'claude-sonnet-4-5' },
        complex: { type: 'claude', model: 'claude-opus-4-7' },
        main: { type: 'claude', model: 'claude-opus-4-7' },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an empty string model', () => {
    const result = multiModelConfigSchema.safeParse({
      agents: {
        standard: { type: 'claude', model: '' },
        complex: { type: 'claude', model: 'claude-opus-4-7' },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i =>
        i.path.includes('model') && i.message.includes('1:1 invariant'),
      )).toBe(true);
    }
  });

  // The pre-v4.0 shape — the one a migrating config actually carries. The old assertion here was
  // `expect(result.success).toBe(false)` under the name "with a clear message", and it checked no
  // message: this input ALSO omits `complex` and `main`, so it fails whether or not the model
  // field is the reason. It passed against Zod's default "expected string, received array".
  it('rejects an array-shaped model with the same 1:1 explanation as an empty one', () => {
    const result = multiModelConfigSchema.safeParse({
      agents: {
        standard: { type: 'claude', model: ['a', 'b'] },
        complex: { type: 'claude', model: 'claude-opus-4-7' },
        main: { type: 'claude', model: 'claude-opus-4-7' },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.includes('model'));
      expect(issue?.path).toEqual(['agents', 'standard', 'model']);
      expect(issue?.message).toContain('1:1 invariant');
    }
  });
});
