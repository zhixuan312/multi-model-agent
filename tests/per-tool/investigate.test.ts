import { describe, it, expect } from 'vitest';
import { toolConfig } from '../../packages/core/src/tools/investigate/tool-config.js';
import type {
  EnrichedInvestigateInput,
  InvestigateBrief,
} from '../../packages/core/src/tools/investigate/tool-config.js';

// Per-tool integration coverage for investigate.
//
// The active production path is toolConfig.briefSlot + toolConfig.buildTaskSpec.
// The legacy `compiledPrompt` (a full investigate-specific prompt forwarded as
// TaskSpec.prompt) was removed: the worker input is built by the read-route
// dispatcher from `parallelTarget` (`Question: <q>`) + FINDING_FORMAT_SHARED,
// so the brief now carries only `question` (which also drives the headline via
// the task-executor's taskBrief `?? .question` fallback).

function makeInput(overrides: Partial<EnrichedInvestigateInput> = {}): EnrichedInvestigateInput {
  return {
    question: 'How does X work?',
    canonicalizedFilePaths: [],
    ...overrides,
  } as EnrichedInvestigateInput;
}

describe('investigate toolConfig.briefSlot', () => {
  it('produces exactly one brief regardless of file count', () => {
    const briefs = toolConfig.briefSlot(
      makeInput({ canonicalizedFilePaths: ['/x/a.ts', '/x/b.ts'] }),
    );
    expect(briefs).toHaveLength(1);
  });

  it('preserves the user question on the brief (drives headline)', () => {
    const briefs = toolConfig.briefSlot(makeInput({ question: 'How does the auth-token rule work?' }));
    expect(briefs[0].question).toBe('How does the auth-token rule work?');
  });

  it('does NOT put a `prompt`/`compiledPrompt` field on the brief', () => {
    // A `prompt`/`brief` field would make the task-executor's taskBrief chain
    // leak prompt text into the headline instead of the question.
    const brief = toolConfig.briefSlot(makeInput({ question: 'q' }))[0] as InvestigateBrief & {
      prompt?: unknown;
      compiledPrompt?: unknown;
    };
    expect(brief.prompt).toBeUndefined();
    expect(brief.compiledPrompt).toBeUndefined();
    expect(brief.question).toBe('q');
  });

  it('forwards filePaths + contextBlockIds onto the brief', () => {
    const briefs = toolConfig.briefSlot(
      makeInput({ canonicalizedFilePaths: ['/cwd/src/auth.ts'], contextBlockIds: ['cb-1'] }),
    );
    expect(briefs[0].filePaths).toEqual(['/cwd/src/auth.ts']);
    expect(briefs[0].contextBlockIds).toEqual(['cb-1']);
  });

  it('forwards tools=readonly default and respects caller tools=none', () => {
    const briefsDefault = toolConfig.briefSlot(makeInput({ tools: undefined }));
    expect(briefsDefault[0].tools).toBeUndefined();
    const briefsNone = toolConfig.briefSlot(makeInput({ tools: 'none' }));
    expect(briefsNone[0].tools).toBe('none');
  });
});

describe('investigate toolConfig.buildTaskSpec', () => {
  it('sets TaskSpec.prompt + parallelTarget from the question', () => {
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
