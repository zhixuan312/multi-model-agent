import { describe, it, expect } from 'bun:test';
import { multiModelConfigSchema } from '../../packages/core/src/config/schema.js';

describe('agents.<tier>.model — single-model invariant', () => {
  const base = {
    defaults: {},
  };

  it('accepts a single string model id', () => {
    const result = multiModelConfigSchema.safeParse({
      ...base,
      agents: {
        standard: { type: 'claude', model: 'claude-sonnet-4-5' },
        complex: { type: 'claude', model: 'claude-opus-4-7' },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an empty string model', () => {
    const result = multiModelConfigSchema.safeParse({
      ...base,
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

  it('rejects an array-shaped model with a clear message', () => {
    const result = multiModelConfigSchema.safeParse({
      ...base,
      agents: {
        standard: { type: 'claude', model: ['a', 'b'] },
      },
    });
    expect(result.success).toBe(false);
  });
});
