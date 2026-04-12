import { describe, it, expect } from 'vitest';
import { executePlanTaskSchema } from '@zhixuan92/multi-model-agent-mcp/tools/execute-plan-task';

describe('executePlanTask', () => {
  it('accepts valid params', () => {
    const result = executePlanTaskSchema.safeParse({
      prompt: 'do X',
      agentType: 'standard',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid agentType', () => {
    const result = executePlanTaskSchema.safeParse({
      prompt: 'do X',
      agentType: 'invalid',
    });
    expect(result.success).toBe(false);
  });
});