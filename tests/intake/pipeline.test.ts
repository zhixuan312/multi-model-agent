import { runIntakePipeline } from '../../packages/core/src/intake/pipeline.js';
import type { DraftTask, DelegateSource } from '../../packages/core/src/intake/types.js';
import type { MultiModelConfig } from '@zhixuan92/multi-model-agent-core';

const config: MultiModelConfig = {
  agents: {
    standard: { type: 'openai-compatible' as const, model: 'std', baseUrl: 'http://localhost' },
    complex: { type: 'openai-compatible' as const, model: 'cpx', baseUrl: 'http://localhost' },
  },
  defaults: { timeoutMs: 600_000, tools: 'full' as const },
};

function makeDraft(overrides: Partial<DraftTask> = {}): DraftTask {
  return {
    draftId: 'test:0:root',
    source: { route: 'delegate_tasks', originalInput: {} } as DelegateSource,
    prompt: 'reply with a short greeting to the user',
    done: 'Return a greeting',
    ...overrides,
  } as DraftTask;
}

describe('runIntakePipeline', () => {
  it('classifies clear task as ready and resolves to TaskSpec', () => {
    const result = runIntakePipeline([makeDraft()], config);
    expect(result.ready).toHaveLength(1);
    expect(result.clarifications).toHaveLength(0);
    expect(result.ready[0].task.prompt).toContain('reply with a short greeting');
    expect(result.ready[0].task.briefQualityPolicy).toBe('off');
    expect(result.ready[0].draftId).toBe('test:0:root');
  });

  it('classifies vague task as needs_confirmation', () => {
    const result = runIntakePipeline([makeDraft({
      prompt: 'fix it',
      done: undefined,
    })], config);
    expect(result.ready).toHaveLength(0);
    expect(result.clarifications).toHaveLength(1);
    expect(result.clarifications[0].draftId).toBe('test:0:root');
    expect(result.clarifications[0].proposedDraft.prompt).toContain('fix it');
    expect(result.clarifications[0].reason).toBeDefined();
  });

  it('handles mixed batch with partial execution', () => {
    const drafts = [
      makeDraft({ draftId: 'test:0:root', prompt: 'say hello', done: 'greeting returned' }),
      makeDraft({ draftId: 'test:1:root', prompt: 'fix it', done: undefined }),
    ];
    const result = runIntakePipeline(drafts, config);
    expect(result.ready).toHaveLength(1);
    expect(result.clarifications).toHaveLength(1);
    expect(result.ready[0].draftId).toBe('test:0:root');
    expect(result.clarifications[0].draftId).toBe('test:1:root');
  });

  it('computes intakeProgress correctly', () => {
    const drafts = [
      makeDraft({ draftId: 'test:0:root', prompt: 'say hello', done: 'done' }),
      makeDraft({ draftId: 'test:1:root', prompt: 'fix it', done: undefined }),
    ];
    const result = runIntakePipeline(drafts, config);
    expect(result.intakeProgress).toEqual({
      totalDrafts: 2,
      readyDrafts: 1,
      clarificationDrafts: 1,
      hardErrorDrafts: 0,
      executedDrafts: 0,
    });
  });

  it('satisfies intakeProgress invariant: ready + clarification + error = total', () => {
    const result = runIntakePipeline([
      makeDraft({ draftId: 'a:0:root' }),
      makeDraft({ draftId: 'b:1:root', prompt: 'fix it', done: undefined }),
    ], config);
    const p = result.intakeProgress;
    expect(p.readyDrafts + p.clarificationDrafts + p.hardErrorDrafts).toBe(p.totalDrafts);
  });

  it('infers missing fields before classification', () => {
    const result = runIntakePipeline([makeDraft({
      prompt: 'summarize the contents of src/auth.ts',
      done: undefined,
    })], config);
    expect(result.ready).toHaveLength(1);
  });

  it('returns empty results for empty input', () => {
    const result = runIntakePipeline([], config);
    expect(result.ready).toHaveLength(0);
    expect(result.clarifications).toHaveLength(0);
    expect(result.intakeProgress.totalDrafts).toBe(0);
  });

  it('handles unrecoverable classification as hard error', () => {
    const result = runIntakePipeline([makeDraft({ prompt: '' })], config);
    expect(result.hardErrors).toHaveLength(1);
    expect(result.hardErrors[0].errorCode).toBe('unrecoverable_ambiguity');
  });
});