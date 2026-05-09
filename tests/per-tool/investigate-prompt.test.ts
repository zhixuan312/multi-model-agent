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
    // All 8 categories should each surface in the worker's prompt.
    expect(spec.prompt).toContain('WRONG FILE');
    expect(spec.prompt).toContain('STALE QUOTE');
    expect(spec.prompt).toContain('HALLUCINATED CITATION');
    expect(spec.prompt).toContain('CONFIDENCE OVERSTATEMENT');
    expect(spec.prompt).toContain('CITATION GAP');
    expect(spec.prompt).toContain('QUESTION SHIFT');
    expect(spec.prompt).toContain('SYNTHESIS WITHOUT GROUNDING');
    expect(spec.prompt).toContain('ASSUMED-CURRENT-STATE');
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
