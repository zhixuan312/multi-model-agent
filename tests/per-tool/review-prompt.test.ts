import { describe, it, expect } from 'vitest';
import { toolConfig } from '../../packages/core/src/tools/review/tool-config.js';
import type { ExecutionContext } from '../../packages/core/src/lifecycle/lifecycle-context.js';

const ctx = {
  cwd: '/tmp',
  config: { defaults: {} },
  projectContext: undefined,
  mainModel: undefined,
} as unknown as ExecutionContext;

describe('review prompt content', () => {
  it('demands file:line + code quote', () => {
    const briefs = toolConfig.briefSlot({ filePaths: ['/x/a.ts'], focus: ['security'], contextBlockIds: [] } as any);
    const spec = toolConfig.buildTaskSpec(briefs[0], ctx);
    expect(spec.prompt).toContain('Cite `file:line`');
    expect(spec.prompt).toContain('The named files');
    expect(spec.prompt).not.toContain('absence-finding');
  });
});
