import { describe, it, expect } from 'vitest';
import { toolConfig } from '../../packages/core/src/tools/verify/tool-config.js';
import type { ExecutionContext } from '../../packages/core/src/lifecycle/lifecycle-context.js';

const ctx = {
  cwd: '/tmp',
  config: { defaults: {} },
  projectContext: undefined,
  mainModel: undefined,
} as unknown as ExecutionContext;

describe('verify prompt content', () => {
  it('binds severity to PASS=low / FAIL=medium-high and demands 1:1 mapping', () => {
    const briefs = toolConfig.briefSlot({ work: 'build', checklist: ['unit tests pass', 'lint passes'], filePaths: [], contextBlockIds: [] } as any);
    const spec = toolConfig.buildTaskSpec(briefs[0], ctx);
    expect(spec.prompt).toContain('PASS = low');
    expect(spec.prompt).toContain('1:1 to a checklist item');
  });
});
