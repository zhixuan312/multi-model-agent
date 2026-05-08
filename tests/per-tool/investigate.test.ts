import { describe, it, expect } from 'vitest';
import { toolConfig } from '../../packages/core/src/tools/investigate/tool-config.js';
import type {
  EnrichedInvestigateInput,
  InvestigateBrief,
} from '../../packages/core/src/tools/investigate/tool-config.js';

// Per-tool integration coverage for investigate.
//
// Replaces the previous test file that exercised the legacy
// `compileInvestigate` / `investigateSlot` helpers in
// brief-compiler-slots/investigate.ts. Those helpers had no production
// callers (verified by grep across packages/) and were deleted under
// dev-mode rule "delete unused code". The active production path is
// toolConfig.briefSlot + toolConfig.buildTaskSpec, defined inline in
// tools/investigate/tool-config.ts. These tests pin its observable
// shape so the path-coverage.test.ts coverage check stays green and
// the tool sweep #5 fix (renaming brief.prompt → brief.compiledPrompt
// so the headline reads the user's question, not the prompt template)
// can't regress silently.

function makeInput(overrides: Partial<EnrichedInvestigateInput> = {}): EnrichedInvestigateInput {
  return {
    question: 'How does X work?',
    resolvedContextBlocks: [],
    canonicalizedFilePaths: [],
    relativeFilePathsForPrompt: [],
    ...overrides,
  } as EnrichedInvestigateInput;
}

describe('investigate toolConfig.briefSlot', () => {
  it('produces exactly one brief regardless of file count', () => {
    const briefs = toolConfig.briefSlot(
      makeInput({
        canonicalizedFilePaths: ['/x/a.ts', '/x/b.ts'],
        relativeFilePathsForPrompt: ['a.ts', 'b.ts'],
      }),
    );
    expect(briefs).toHaveLength(1);
  });

  it('preserves the user question on the brief (drives headline)', () => {
    const briefs = toolConfig.briefSlot(makeInput({ question: 'How does the auth-token rule work?' }));
    expect(briefs[0].question).toBe('How does the auth-token rule work?');
  });

  it('renders the compiled prompt under `compiledPrompt` (NOT `prompt`)', () => {
    // Sweep #5 fix: a `prompt` field on the brief would cause the
    // task-executor's taskBrief chain to leak the prompt template
    // text into the headline instead of the question.
    const briefs = toolConfig.briefSlot(makeInput({ question: 'q' }));
    const brief = briefs[0] as InvestigateBrief & { prompt?: unknown };
    expect(brief.compiledPrompt).toContain('Question: q');
    expect(brief.compiledPrompt).toContain('## Summary');
    expect(brief.compiledPrompt).toContain('## Citations');
    expect(brief.compiledPrompt).toContain('## Confidence');
    expect(brief.prompt).toBeUndefined();
  });

  it('embeds anchor paths into the compiled prompt', () => {
    const briefs = toolConfig.briefSlot(
      makeInput({
        canonicalizedFilePaths: ['/cwd/src/auth.ts'],
        relativeFilePathsForPrompt: ['src/auth.ts'],
      }),
    );
    expect(briefs[0].compiledPrompt).toContain('- src/auth.ts');
    expect(briefs[0].compiledPrompt).not.toContain('/cwd/src/auth.ts');
  });

  it('embeds resolved context blocks before the question', () => {
    const briefs = toolConfig.briefSlot(
      makeInput({
        resolvedContextBlocks: [{ id: 'ctx-1', content: 'PRIOR REPORT BODY' }],
        question: 'follow-up?',
      }),
    );
    expect(briefs[0].compiledPrompt).toContain('PRIOR REPORT BODY');
    expect(briefs[0].compiledPrompt).toContain('Refine or extend');
    // Question must come AFTER the prior context block.
    const idxCtx = briefs[0].compiledPrompt.indexOf('PRIOR REPORT BODY');
    const idxQ = briefs[0].compiledPrompt.indexOf('Question: follow-up?');
    expect(idxCtx).toBeLessThan(idxQ);
  });

  it('forwards tools=readonly default and respects caller tools=none', () => {
    const briefsDefault = toolConfig.briefSlot(makeInput({ tools: undefined }));
    expect(briefsDefault[0].tools).toBeUndefined();
    const briefsNone = toolConfig.briefSlot(makeInput({ tools: 'none' }));
    expect(briefsNone[0].tools).toBe('none');
  });
});

describe('investigate toolConfig.buildTaskSpec', () => {
  it('forwards brief.compiledPrompt as TaskSpec.prompt', () => {
    const briefs = toolConfig.briefSlot(makeInput({ question: 'q1' }));
    const ctx = {
      cwd: '/cwd',
      mainModel: 'claude-opus-4-7',
      config: { defaults: {} },
    } as unknown as Parameters<typeof toolConfig.buildTaskSpec>[1];
    const spec = toolConfig.buildTaskSpec(briefs[0], ctx);
    expect(spec.prompt).toContain('Question: q1');
  });

  it('propagates ctx.mainModel onto the TaskSpec', () => {
    const briefs = toolConfig.briefSlot(makeInput());
    const ctx = {
      cwd: '/cwd',
      mainModel: 'claude-opus-4-7',
      config: { defaults: {} },
    } as unknown as Parameters<typeof toolConfig.buildTaskSpec>[1];
    const spec = toolConfig.buildTaskSpec(briefs[0], ctx);
    expect(spec.mainModel).toBe('claude-opus-4-7');
  });

  it('coerces ctx.mainModel=null to undefined (TaskSpec accepts string|undefined only)', () => {
    const briefs = toolConfig.briefSlot(makeInput());
    const ctx = {
      cwd: '/cwd',
      mainModel: null,
      config: { defaults: {} },
    } as unknown as Parameters<typeof toolConfig.buildTaskSpec>[1];
    const spec = toolConfig.buildTaskSpec(briefs[0], ctx);
    expect(spec.mainModel).toBeUndefined();
  });
});
