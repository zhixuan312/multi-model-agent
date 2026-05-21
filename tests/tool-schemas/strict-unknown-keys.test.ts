import { describe, it, expect } from 'vitest';
import { inputSchema as delegateSchema } from '../../packages/core/src/tools/delegate/schema.js';
import { executePlanInputSchema as executePlanSchema } from '../../packages/core/src/tools/execute-plan/tool-config.js';

describe('delegate schema rejects verifyCommand (strict mode regression guard)', () => {
  it('rejects task with verifyCommand', () => {
    const result = delegateSchema.safeParse({
      tasks: [{
        prompt: 'do thing',
        verifyCommand: ['npm', 'test'],
      }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // Zod strict mode reports unrecognized_keys
      expect(JSON.stringify(result.error.issues)).toMatch(/verifyCommand|unrecognized/i);
    }
  });

  it('accepts valid task without verifyCommand', () => {
    const result = delegateSchema.safeParse({
      tasks: [{ prompt: 'do thing' }],
    });
    expect(result.success).toBe(true);
  });
});

describe('execute-plan schema rejects verifyCommand (strict mode regression guard)', () => {
  it('rejects top-level verifyCommand', () => {
    const result = executePlanSchema.safeParse({
      filePaths: ['plan.md'],
      taskDescriptors: ['1. Setup'],
      verifyCommand: ['npm', 'test'],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).toMatch(/verifyCommand|unrecognized/i);
    }
  });

  it('accepts valid input without verifyCommand', () => {
    const result = executePlanSchema.safeParse({
      filePaths: ['plan.md'],
      taskDescriptors: ['1. Setup'],
    });
    expect(result.success).toBe(true);
  });
});
