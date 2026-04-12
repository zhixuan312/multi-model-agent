import { describe, it, expect } from 'vitest';
import { debugTaskSchema } from '@zhixuan92/multi-model-agent-mcp/tools/debug-task';

describe('debug_task', () => {
  it('accepts valid params', () => {
    const result = debugTaskSchema.safeParse({
      problem: 'app crashes on startup',
      context: 'Node 22, TypeScript 5',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid agentType', () => {
    const result = debugTaskSchema.safeParse({
      problem: 'app crashes',
      agentType: 'invalid',
    });
    expect(result.success).toBe(false);
  });
});