import { describe, it, expect } from 'vitest';
import { reviewCodeSchema } from '@zhixuan92/multi-model-agent-mcp/tools/review-code';

describe('review_code', () => {
  it('accepts valid params', () => {
    const result = reviewCodeSchema.safeParse({
      code: 'function hello() { return "world"; }',
      focus: ['security', 'performance'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid focus type', () => {
    const result = reviewCodeSchema.safeParse({
      code: 'function hello() { return "world"; }',
      focus: ['invalid'],
    });
    expect(result.success).toBe(false);
  });
});