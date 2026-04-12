import { describe, it, expect } from 'vitest';
import { auditDocumentSchema } from '@zhixuan92/multi-model-agent-mcp/tools/audit-document';

describe('audit_document', () => {
  it('accepts valid params', () => {
    const result = auditDocumentSchema.safeParse({
      document: 'some content',
      auditType: 'security',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid auditType', () => {
    const result = auditDocumentSchema.safeParse({
      document: 'content',
      auditType: 'invalid',
    });
    expect(result.success).toBe(false);
  });
});