// tests/tools/journal-record-schema.test.ts
import { inputSchema } from '../../packages/core/src/tools/journal/record/schema.js';

describe('journal record schema', () => {
  it('accepts a one-element learnings array with optional batch tagHints', () => {
    expect(inputSchema.safeParse({ learnings: ['x'.repeat(20)], tagHints: ['journal'] }).success).toBe(true);
  });
  it('accepts up to 20 learnings', () => {
    expect(inputSchema.safeParse({ learnings: Array.from({ length: 20 }, () => 'x'.repeat(20)) }).success).toBe(true);
  });
  it('rejects an empty learnings array', () => {
    expect(inputSchema.safeParse({ learnings: [] }).success).toBe(false);
  });
  it('rejects more than 20 learnings', () => {
    expect(inputSchema.safeParse({ learnings: Array.from({ length: 21 }, () => 'x'.repeat(20)) }).success).toBe(false);
  });
  it('rejects a too-short learning member', () => {
    expect(inputSchema.safeParse({ learnings: ['too short'] }).success).toBe(false);
  });
  it('rejects the removed singular `learning` key (strict)', () => {
    expect(inputSchema.safeParse({ learning: 'x'.repeat(20) }).success).toBe(false);
  });
  it('rejects unknown keys (strict)', () => {
    expect(inputSchema.safeParse({ learnings: ['x'.repeat(20)], bogus: 1 }).success).toBe(false);
  });
});
