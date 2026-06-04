import { describe, it, expect } from 'vitest';
import { inputSchema as delegateInputSchema } from '../../packages/core/src/tools/delegate/schema.js';

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
