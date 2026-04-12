import { describe, it, expect } from 'vitest';
import { verifyWorkSchema } from '@zhixuan92/multi-model-agent-mcp/tools/verify-work';

describe('verify_work', () => {
  it('accepts valid params', () => {
    const result = verifyWorkSchema.safeParse({
      work: 'implementation of feature X',
      checklist: ['has tests', 'handles edge cases'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty checklist', () => {
    const result = verifyWorkSchema.safeParse({
      work: 'implementation of feature X',
      checklist: [],
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid agentType', () => {
    const result = verifyWorkSchema.safeParse({
      work: 'implementation',
      checklist: ['item 1'],
      agentType: 'invalid',
    });
    expect(result.success).toBe(false);
  });
});