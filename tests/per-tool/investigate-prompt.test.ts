import { describe, it, expect } from 'vitest';
import { toolConfig } from '../../packages/core/src/tools/investigate/tool-config.js';
import type { ExecutionContext } from '../../packages/core/src/lifecycle/lifecycle-context.js';

const ctx = {
  cwd: '/tmp',
  config: { defaults: {} },
  projectContext: undefined,
  mainModel: undefined,
} as unknown as ExecutionContext;

describe('investigate prompt content', () => {
  it('treats negative findings as legitimate and does not require code quotes', () => {
    const briefs = toolConfig.briefSlot({
      question: 'is foo still used',
      resolvedContextBlocks: [],
      canonicalizedFilePaths: [],
      relativeFilePathsForPrompt: [],
      contextBlockIds: [],
    } as any);
    const spec = toolConfig.buildTaskSpec(briefs[0], ctx);
    expect(spec.prompt).toContain('searched <pattern>');
    expect(spec.prompt).toContain('negative findings are legitimate answers');
  });
});
