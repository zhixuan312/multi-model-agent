import { describe, it, expect } from 'vitest';
import { inputSchema as delegateInputSchema } from '../../packages/core/src/tool-schemas/delegate.js';

describe('TaskSpec.verifyCommand', () => {
  // baseTask includes maxCostUSD because Chapter 6 makes it required (Audit-r2 plan finding 1).
  const baseTask = { prompt: 'x', maxCostUSD: 1 };

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

  it('omitting maxCostUSD is allowed (executor applies default of 10)', () => {
    const r = delegateInputSchema.safeParse({ tasks: [{ prompt: 'x' }] });
    expect(r.success).toBe(true);
  });
  it('rejects maxCostUSD <= 0 when explicitly passed', () => {
    const r = delegateInputSchema.safeParse({ tasks: [{ prompt: 'x', maxCostUSD: 0 }] });
    expect(r.success).toBe(false);
  });
  it('rejects non-finite maxCostUSD when explicitly passed', () => {
    const r = delegateInputSchema.safeParse({ tasks: [{ prompt: 'x', maxCostUSD: Infinity }] });
    expect(r.success).toBe(false);
  });
});
