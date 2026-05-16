import { describe, it, expect } from 'vitest';
import { inputSchema as delegateInputSchema } from '../../packages/core/src/tools/delegate/schema.js';

describe('TaskSpec.verifyCommand', () => {
  const baseTask = { prompt: 'x' };

  it('accepts valid array of non-empty strings', () => {
    const r = delegateInputSchema.safeParse({ tasks: [{ ...baseTask, verifyCommand: ['npm test'] }] });
    expect(r.success).toBe(true);
  });

  it('rejects empty array', () => {
    const r = delegateInputSchema.safeParse({ tasks: [{ ...baseTask, verifyCommand: [] }] });
    expect(r.success).toBe(false);
  });

  it('rejects whitespace-only items', () => {
    const r = delegateInputSchema.safeParse({ tasks: [{ ...baseTask, verifyCommand: ['   '] }] });
    expect(r.success).toBe(false);
  });

  it('omitting verifyCommand is allowed', () => {
    const r = delegateInputSchema.safeParse({ tasks: [baseTask] });
    expect(r.success).toBe(true);
  });
});
