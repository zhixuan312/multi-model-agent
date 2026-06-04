import { describe, it, expect } from 'vitest';
import { inputSchema } from '../../../packages/core/src/tools/delegate/schema.js';

describe('agentType enum closure', () => {
  it('rejects free-form agentType at the Zod boundary', () => {
    const r = inputSchema.safeParse({ tasks: [{ prompt: 'test', agentType: 'foo' }] });
    expect(r.success).toBe(false);
    if (!r.success) {
      // Zod flatten() surfaces array-item errors under the array key
      const fieldErrors = r.error.flatten().fieldErrors;
      expect(fieldErrors).toHaveProperty('tasks');
    }
  });

  it('accepts agentType: standard', () => {
    const r = inputSchema.safeParse({ tasks: [{ prompt: 'test', agentType: 'standard' }] });
    expect(r.success).toBe(true);
  });

  it('accepts agentType: complex', () => {
    const r = inputSchema.safeParse({ tasks: [{ prompt: 'test', agentType: 'complex' }] });
    expect(r.success).toBe(true);
  });

  it('accepts missing agentType (optional)', () => {
    const r = inputSchema.safeParse({ tasks: [{ prompt: 'test' }] });
    expect(r.success).toBe(true);
  });

  it('rejects invalid agentType values like numeric strings', () => {
    const r = inputSchema.safeParse({ tasks: [{ prompt: 'test', agentType: 'simple' }] });
    expect(r.success).toBe(false);
  });
});
