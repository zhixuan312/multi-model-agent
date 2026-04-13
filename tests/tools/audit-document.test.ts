import { describe, it, expect } from 'vitest';
import { auditDocumentSchema } from '@zhixuan92/multi-model-agent-mcp/tools/audit-document';

describe('audit_document schema', () => {
  it('accepts inline document with string auditType', () => {
    const result = auditDocumentSchema.safeParse({ document: 'content', auditType: 'security' });
    expect(result.success).toBe(true);
  });
  it('accepts filePaths without document', () => {
    const result = auditDocumentSchema.safeParse({ auditType: 'correctness', filePaths: ['a.ts', 'b.ts'] });
    expect(result.success).toBe(true);
  });
  it('accepts auditType as array', () => {
    const result = auditDocumentSchema.safeParse({ document: 'c', auditType: ['security', 'performance'] });
    expect(result.success).toBe(true);
  });
  it('accepts general auditType', () => {
    const result = auditDocumentSchema.safeParse({ document: 'c', auditType: 'general' });
    expect(result.success).toBe(true);
  });
  it('accepts outputFormat', () => {
    const result = auditDocumentSchema.safeParse({ document: 'c', auditType: 'style', outputFormat: 'json' });
    expect(result.success).toBe(true);
  });
  it('accepts common fields', () => {
    const result = auditDocumentSchema.safeParse({ document: 'c', auditType: 'correctness', cwd: '/tmp', contextBlockIds: ['abc'], tools: 'readonly', filePaths: ['ref.ts'] });
    expect(result.success).toBe(true);
  });
  it('rejects invalid auditType', () => {
    expect(auditDocumentSchema.safeParse({ document: 'c', auditType: 'invalid' }).success).toBe(false);
  });
  it('rejects empty auditType array', () => {
    expect(auditDocumentSchema.safeParse({ document: 'c', auditType: [] }).success).toBe(false);
  });
  it('allows both absent (handler validates)', () => {
    expect(auditDocumentSchema.safeParse({ auditType: 'security' }).success).toBe(true);
  });
});
