import { describe, it, expect } from 'vitest';
import { reviewCodeSchema } from '@zhixuan92/multi-model-agent-mcp/tools/review-code';

describe('review_code schema', () => {
  it('accepts inline code', () => {
    expect(reviewCodeSchema.safeParse({ code: 'fn()' }).success).toBe(true);
  });
  it('accepts filePaths without code', () => {
    expect(reviewCodeSchema.safeParse({ filePaths: ['a.ts'] }).success).toBe(true);
  });
  it('accepts focus array', () => {
    expect(reviewCodeSchema.safeParse({ code: 'x', focus: ['security', 'performance'] }).success).toBe(true);
  });
  it('accepts outputFormat', () => {
    expect(reviewCodeSchema.safeParse({ code: 'x', outputFormat: 'json' }).success).toBe(true);
  });
  it('accepts common fields', () => {
    expect(reviewCodeSchema.safeParse({ code: 'x', cwd: '/tmp', tools: 'readonly', contextBlockIds: ['a'] }).success).toBe(true);
  });
  it('allows both absent (handler validates)', () => {
    expect(reviewCodeSchema.safeParse({}).success).toBe(true);
  });
});
