import { describe, it, expect } from 'vitest';
import { inputSchema as delegateInputSchema } from '../../packages/core/src/tools/delegate/schema.js';
import { inputSchema as executePlanInputSchema } from '../../packages/core/src/tools/execute-plan/schema.js';

describe('delegate schema — outputTargets', () => {
  it('accepts optional outputTargets string array', () => {
    const result = delegateInputSchema.safeParse({
      tasks: [{ prompt: 'do x', outputTargets: ['src/foo.ts', '/abs/path/bar.ts'] }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects non-string entries in outputTargets', () => {
    const result = delegateInputSchema.safeParse({
      tasks: [{ prompt: 'do x', outputTargets: [123] }],
    });
    expect(result.success).toBe(false);
  });

  it('accepts omission of outputTargets', () => {
    const result = delegateInputSchema.safeParse({ tasks: [{ prompt: 'do x' }] });
    expect(result.success).toBe(true);
  });

  it('rejects empty strings in outputTargets', () => {
    const result = delegateInputSchema.safeParse({
      tasks: [{ prompt: 'do x', outputTargets: [''] }],
    });
    expect(result.success).toBe(false);
  });
});

describe('execute-plan schema — outputTargets (object task form only)', () => {
  it('accepts outputTargets on the object task form', () => {
    const result = executePlanInputSchema.safeParse({
      tasks: [{ task: '1. Setup', outputTargets: ['src/foo.ts'] }],
    });
    expect(result.success).toBe(true);
  });

  it('string task form has no outputTargets (still valid)', () => {
    const result = executePlanInputSchema.safeParse({
      tasks: ['1. Setup'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects non-string entries in outputTargets', () => {
    const result = executePlanInputSchema.safeParse({
      tasks: [{ task: '1. Setup', outputTargets: [123] }],
    });
    expect(result.success).toBe(false);
  });
});
