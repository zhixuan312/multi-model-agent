import { describe, it, expect } from 'vitest';
import { compileAuditDocument } from '../../../packages/core/src/intake/compilers/audit.js';

describe('audit compiler', () => {
  it('returns single draft for <=1 file', () => {
    const drafts = compileAuditDocument({ auditType: 'security' }, 'req');
    expect(drafts).toHaveLength(1);
    expect(drafts[0].source.route).toBe('audit_document');
  });

  it('fans out to N drafts for N files', () => {
    const drafts = compileAuditDocument({
      filePaths: ['a.ts', 'b.ts'],
      auditType: 'style',
    }, 'req');
    expect(drafts).toHaveLength(2);
    expect(drafts[0].draftId).toBe('req:0:a.ts');
    expect(drafts[1].draftId).toBe('req:1:b.ts');
  });

  it('includes output contract in prompt', () => {
    const drafts = compileAuditDocument({ auditType: 'security' }, 'req');
    expect(drafts[0].prompt).toContain('structured audit report');
  });
});