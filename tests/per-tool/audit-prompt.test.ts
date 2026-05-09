import { describe, it, expect } from 'vitest';
import { toolConfig } from '../../packages/core/src/tools/audit/tool-config.js';
import type { ExecutionContext } from '../../packages/core/src/lifecycle/lifecycle-context.js';

const ctx = {
  cwd: '/tmp',
  config: { defaults: {} },
  projectContext: undefined,
  mainModel: undefined,
} as unknown as ExecutionContext;

describe('audit prompt content', () => {
  it('includes audit-specific evidence rule (doc quote / absence / claim+contradiction)', () => {
    const briefs = toolConfig.briefSlot({ auditType: 'default', filePaths: ['/x/spec.md'], document: undefined, contextBlockIds: [] } as any);
    const spec = toolConfig.buildTaskSpec(briefs[0], ctx);
    expect(spec.prompt).toContain('absence-finding');
    expect(spec.prompt).toContain('Section 3.2');
    expect(spec.prompt).not.toContain('Stay within the requested files');
  });

  it('keeps cross-section reasoning IN scope', () => {
    const briefs = toolConfig.briefSlot({ auditType: 'default', filePaths: ['/x/spec.md'], document: undefined, contextBlockIds: [] } as any);
    const spec = toolConfig.buildTaskSpec(briefs[0], ctx);
    expect(spec.prompt).toContain('Cross-section reasoning within the document IS in scope');
  });

  it('includes the doc-audit failure-mode taxonomy', () => {
    const briefs = toolConfig.briefSlot({ auditType: 'default', filePaths: ['/x/spec.md'], document: undefined, contextBlockIds: [] } as any);
    const spec = toolConfig.buildTaskSpec(briefs[0], ctx);
    // All 11 categories should each surface in the worker's prompt.
    expect(spec.prompt).toContain('RECOMMENDATION-COHERENCE');
    expect(spec.prompt).toContain('INTERNAL CONTRADICTION');
    expect(spec.prompt).toContain('CROSS-ITEM DUPLICATION');
    expect(spec.prompt).toContain('INDEPENDENCE-CLAIMED-WITHOUT-EVIDENCE');
    expect(spec.prompt).toContain('ARGUMENT SOUNDNESS');
    expect(spec.prompt).toContain('COMPLETENESS AGAINST CONSTRAINTS');
    expect(spec.prompt).toContain('FIX ACTIONABILITY');
    expect(spec.prompt).toContain('DRIFT / STALENESS');
    expect(spec.prompt).toContain('SCOPE-CREEP / FRAMING');
    expect(spec.prompt).toContain('STRUCTURAL CONSISTENCY');
    expect(spec.prompt).toContain('METADATA COMPLETENESS');
  });

  it('counter-balances the anti-inflation hint with a thoroughness reminder', () => {
    const briefs = toolConfig.briefSlot({ auditType: 'default', filePaths: ['/x/spec.md'], document: undefined, contextBlockIds: [] } as any);
    const spec = toolConfig.buildTaskSpec(briefs[0], ctx);
    expect(spec.prompt).toContain('Thoroughness expectation for prose-document audits');
    expect(spec.prompt).toContain('zero or 1-2 findings is unusual');
  });

  it('accepts internal-coherence as the fourth evidence shape', () => {
    const briefs = toolConfig.briefSlot({ auditType: 'default', filePaths: ['/x/spec.md'], document: undefined, contextBlockIds: [] } as any);
    const spec = toolConfig.buildTaskSpec(briefs[0], ctx);
    expect(spec.prompt).toContain('INTERNAL-COHERENCE');
  });

  it('done condition for `default` leads with the prose-document lens', () => {
    const briefs = toolConfig.briefSlot({ auditType: 'default', filePaths: ['/x/spec.md'], document: undefined, contextBlockIds: [] } as any);
    const spec = toolConfig.buildTaskSpec(briefs[0], ctx);
    expect(spec.done).toContain('prose artifacts');
    expect(spec.done).toContain('RECOMMENDATION-COHERENCE');
  });

  it('omitting auditType uses the default lens', () => {
    const briefs = toolConfig.briefSlot({ filePaths: ['/x/spec.md'], document: undefined, contextBlockIds: [] } as any);
    expect(briefs.length).toBe(1);
    const spec = toolConfig.buildTaskSpec(briefs[0], ctx);
    expect(spec.done).toContain('Comprehensive audit');
  });

  it('opens with the executability orientation block on every audit type', () => {
    for (const auditType of ['default', 'security', 'performance'] as const) {
      const briefs = toolConfig.briefSlot({ auditType, filePaths: ['/x/spec.md'], document: undefined, contextBlockIds: [] } as any);
      const spec = toolConfig.buildTaskSpec(briefs[0], ctx);
      expect(spec.prompt).toContain('EXECUTED BY A LOW-JUDGMENT WORKER');
      expect(spec.prompt).toContain('would a worker that reads only this artifact');
    }
  });
});
