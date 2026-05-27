import { describe, it, expect } from 'bun:test';
import { toolConfig } from '../../packages/core/src/tools/audit/tool-config.js';
import type { ExecutionContext } from '../../packages/core/src/lifecycle/lifecycle-context.js';

const ctx = {
  cwd: '/tmp',
  config: { defaults: {} },
  projectContext: undefined,
  mainModel: undefined,
} as unknown as ExecutionContext;

describe('audit toolConfig.buildTaskSpec', () => {
  it('sets reviewPolicy to none', () => {
    const briefs = toolConfig.briefSlot({ filePaths: ['/x/spec.md'], document: undefined, contextBlockIds: [] } as any);
    const spec = toolConfig.buildTaskSpec(briefs[0], ctx);
    expect(spec.reviewPolicy).toBe('none');
  });
});
