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

  it('opens with the answer-and-act orientation block', () => {
    const briefs = toolConfig.briefSlot({
      question: 'is foo still used',
      resolvedContextBlocks: [],
      canonicalizedFilePaths: [],
      relativeFilePathsForPrompt: [],
      contextBlockIds: [],
    } as any);
    const spec = toolConfig.buildTaskSpec(briefs[0], ctx);
    expect(spec.prompt).toContain('answer-and-act loop');
    expect(spec.prompt).toContain('A wrong file path becomes a bug');
  });

  it('includes the investigate failure-mode taxonomy', () => {
    const briefs = toolConfig.briefSlot({
      question: 'is foo still used',
      resolvedContextBlocks: [],
      canonicalizedFilePaths: [],
      relativeFilePathsForPrompt: [],
      contextBlockIds: [],
    } as any);
    const spec = toolConfig.buildTaskSpec(briefs[0], ctx);
    // 5 parallel answering perspectives; each sub-worker takes one.
    expect(spec.prompt).toContain('DIRECT-SYMBOL-TRACE PERSPECTIVE');
    expect(spec.prompt).toContain('CALLER-ANALYSIS PERSPECTIVE');
    expect(spec.prompt).toContain('TEST-DRIVEN PERSPECTIVE');
    expect(spec.prompt).toContain('CROSS-FILE DEPENDENCY-MAP PERSPECTIVE');
    expect(spec.prompt).toContain('DOCUMENTATION/COMMENT-LENS PERSPECTIVE');
  });

  it('includes the citation-chain walk with worked example', () => {
    const briefs = toolConfig.briefSlot({
      question: 'is foo still used',
      resolvedContextBlocks: [],
      canonicalizedFilePaths: [],
      relativeFilePathsForPrompt: [],
      contextBlockIds: [],
    } as any);
    const spec = toolConfig.buildTaskSpec(briefs[0], ctx);
    expect(spec.prompt).toContain('Citation-chain walk');
    expect(spec.prompt).toContain('Worked example');
    expect(spec.prompt).toContain('EVIDENCE STRENGTH');
  });
});
