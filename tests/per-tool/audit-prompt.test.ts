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
    const briefs = toolConfig.briefSlot({ auditType: 'correctness', filePaths: ['/x/spec.md'], document: undefined, contextBlockIds: [] } as any);
    const spec = toolConfig.buildTaskSpec(briefs[0], ctx);
    expect(spec.prompt).toContain('absence-finding');
    expect(spec.prompt).toContain('Section 3.2');
    expect(spec.prompt).not.toContain('Stay within the requested files');
  });

  it('keeps cross-section reasoning IN scope', () => {
    const briefs = toolConfig.briefSlot({ auditType: 'correctness', filePaths: ['/x/spec.md'], document: undefined, contextBlockIds: [] } as any);
    const spec = toolConfig.buildTaskSpec(briefs[0], ctx);
    expect(spec.prompt).toContain('Cross-section reasoning within the document IS in scope');
  });
});
