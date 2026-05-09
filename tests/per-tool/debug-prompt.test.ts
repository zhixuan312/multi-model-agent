import { describe, it, expect } from 'vitest';
import { toolConfig } from '../../packages/core/src/tools/debug/tool-config.js';
import type { ExecutionContext } from '../../packages/core/src/lifecycle/lifecycle-context.js';

const ctx = {
  cwd: '/tmp',
  config: { defaults: {} },
  projectContext: undefined,
  mainModel: undefined,
} as unknown as ExecutionContext;

describe('debug prompt content', () => {
  it('allows partial-evidence hypotheses and requires cross-file tracing', () => {
    const briefs = toolConfig.briefSlot({ problem: 'crash on login', filePaths: ['/x/auth.ts'], contextBlockIds: [] } as any);
    const spec = toolConfig.buildTaskSpec(briefs[0], ctx);
    expect(spec.prompt).toContain('PARTIAL evidence are valid');
    expect(spec.prompt).toContain('Cross-file tracing is required');
    expect(spec.prompt).toContain('propose, do not apply');
  });
});
