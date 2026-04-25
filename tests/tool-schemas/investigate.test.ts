// tests/tool-schemas/investigate.test.ts
import { inputSchema } from '../../packages/core/src/tool-schemas/investigate.js';

describe('investigate inputSchema', () => {
  it('accepts a minimal valid request', () => {
    const r = inputSchema.safeParse({ question: 'How does auth work?' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.question).toBe('How does auth work?');
  });

  it('trims whitespace from question and rejects empty after trim', () => {
    expect(inputSchema.safeParse({ question: '   ' }).success).toBe(false);
    const r = inputSchema.safeParse({ question: '   How does X work?   ' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.question).toBe('How does X work?');
  });

  it('accepts tools=none and tools=readonly', () => {
    expect(inputSchema.safeParse({ question: 'q', tools: 'none' }).success).toBe(true);
    expect(inputSchema.safeParse({ question: 'q', tools: 'readonly' }).success).toBe(true);
  });

  it('rejects tools=full', () => {
    const r = inputSchema.safeParse({ question: 'q', tools: 'full' });
    expect(r.success).toBe(false);
    if (!r.success) {
      const issue = r.error.issues.find(i => i.path[0] === 'tools');
      expect(issue?.message).toMatch(/only tools 'none' or 'readonly'/);
    }
  });

  it('rejects tools=no-shell', () => {
    expect(inputSchema.safeParse({ question: 'q', tools: 'no-shell' }).success).toBe(false);
  });

  it('accepts agentType=standard and agentType=complex', () => {
    expect(inputSchema.safeParse({ question: 'q', agentType: 'standard' }).success).toBe(true);
    expect(inputSchema.safeParse({ question: 'q', agentType: 'complex' }).success).toBe(true);
  });

  it('rejects unknown fields (strict)', () => {
    expect(inputSchema.safeParse({ question: 'q', timeoutMs: 60000 }).success).toBe(false);
    expect(inputSchema.safeParse({ question: 'q', maxCostUSD: 1 }).success).toBe(false);
  });

  it('accepts optional filePaths and contextBlockIds arrays', () => {
    const r = inputSchema.safeParse({
      question: 'q',
      filePaths: ['src/auth/'],
      contextBlockIds: ['ctx-1'],
    });
    expect(r.success).toBe(true);
  });

  it('rejects filePaths entries that are empty after trim', () => {
    expect(inputSchema.safeParse({ question: 'q', filePaths: [''] }).success).toBe(false);
    expect(inputSchema.safeParse({ question: 'q', filePaths: ['   '] }).success).toBe(false);
  });
});