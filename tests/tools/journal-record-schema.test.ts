// tests/tools/journal-record-schema.test.ts
import { inputSchema } from '../../packages/core/src/tools/journal/record/schema.js';
describe('journal record schema', () => {
  it('accepts a learning with optional tagHints', () => {
    const r = inputSchema.safeParse({ learning: 'x'.repeat(20), tagHints: ['journal'] });
    expect(r.success).toBe(true);
  });
  it('rejects a too-short learning', () => {
    expect(inputSchema.safeParse({ learning: 'too short' }).success).toBe(false);
  });
  it('rejects unknown keys (strict)', () => {
    expect(inputSchema.safeParse({ learning: 'x'.repeat(20), bogus: 1 }).success).toBe(false);
  });
});
