// tests/tools/journal-recall-schema.test.ts
import { inputSchema } from '../../packages/core/src/tools/journal/recall/schema.js';
describe('journal recall schema', () => {
  it('accepts a conceptual query', () => {
    expect(inputSchema.safeParse({ query: 'what have we learned about dispatch cancellation?' }).success).toBe(true);
  });
  it('rejects a too-short query', () => { expect(inputSchema.safeParse({ query: 'x' }).success).toBe(false); });
  it('rejects unknown keys', () => { expect(inputSchema.safeParse({ query: 'x'.repeat(15), bogus: 1 }).success).toBe(false); });
});
