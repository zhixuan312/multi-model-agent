import { describe, it, expect } from 'vitest';
import { debugTaskSchema } from '@zhixuan92/multi-model-agent-mcp/tools/debug-task';

describe('debug_task schema', () => {
  it('accepts problem with defaults', () => {
    expect(debugTaskSchema.safeParse({ problem: 'bug' }).success).toBe(true);
  });
  it('accepts all optional fields', () => {
    const result = debugTaskSchema.safeParse({
      problem: 'bug', context: 'ctx', hypothesis: 'hyp',
      agentType: 'complex', filePaths: ['a.ts'], cwd: '/tmp',
      contextBlockIds: ['id1'], tools: 'readonly',
    });
    expect(result.success).toBe(true);
  });
  it('rejects missing problem', () => {
    expect(debugTaskSchema.safeParse({ context: 'ctx' }).success).toBe(false);
  });
});
