import { describe, it, expect } from 'vitest';
import { verifyWorkSchema } from '@zhixuan92/multi-model-agent-mcp/tools/verify-work';

describe('verify_work schema', () => {
  it('accepts work with checklist', () => {
    expect(verifyWorkSchema.safeParse({ work: 'done', checklist: ['item1'] }).success).toBe(true);
  });
  it('accepts filePaths without work', () => {
    expect(verifyWorkSchema.safeParse({ filePaths: ['a.ts'], checklist: ['check'] }).success).toBe(true);
  });
  it('rejects empty checklist', () => {
    expect(verifyWorkSchema.safeParse({ work: 'done', checklist: [] }).success).toBe(false);
  });
  it('rejects missing checklist', () => {
    expect(verifyWorkSchema.safeParse({ work: 'done' }).success).toBe(false);
  });
  it('accepts common fields', () => {
    expect(verifyWorkSchema.safeParse({ work: 'x', checklist: ['c'], cwd: '/tmp', tools: 'readonly' }).success).toBe(true);
  });
  it('allows both work and filePaths absent (handler validates)', () => {
    expect(verifyWorkSchema.safeParse({ checklist: ['c'] }).success).toBe(true);
  });
});