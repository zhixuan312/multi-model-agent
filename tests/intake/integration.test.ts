import { describe, it, expect } from 'vitest';
import { runIntakePipeline } from '../../packages/core/src/intake/pipeline.js';
import type { DraftTask, DelegateSource } from '../../packages/core/src/intake/types.js';
import type { MultiModelConfig } from '@zhixuan92/multi-model-agent-core';

const CONFIG: MultiModelConfig = {
  agents: { standard: { type: 'openai-compatible', model: 'std', baseUrl: 'http://localhost' }, complex: { type: 'openai-compatible', model: 'cpx', baseUrl: 'http://localhost' } },
  defaults: { timeoutMs: 600_000, tools: 'full', sandboxPolicy: 'cwd-only' },
};

function makeDraft(overrides: Partial<DraftTask> = {}): DraftTask {
  return {
    draftId: 'test:0:root',
    source: { route: 'delegate_tasks', originalInput: {} } as DelegateSource,
    prompt: 'reply with a short greeting',
    done: 'Return a greeting',
    ...overrides,
  } as DraftTask;
}

describe('intake pipeline integration', () => {
  it('classifies clear task as ready', () => {
    const result = runIntakePipeline([makeDraft()], CONFIG);
    expect(result.ready).toHaveLength(1);
    expect(result.clarifications).toHaveLength(0);
    expect(result.hardErrors).toHaveLength(0);
  });

  it('classifies vague task as needing clarification', () => {
    const result = runIntakePipeline([makeDraft({ prompt: 'fix it', done: undefined })], CONFIG);
    expect(result.ready).toHaveLength(0);
    expect(result.clarifications).toHaveLength(1);
  });

  it('progress invariant: ready + clarification + error = total', () => {
    const result = runIntakePipeline([
      makeDraft({ draftId: 'a:0:root', prompt: 'task 1' }),
      makeDraft({ draftId: 'b:0:root', prompt: 'fix it' }),
    ], CONFIG);
    const p = result.intakeProgress;
    expect(p.readyDrafts + p.clarificationDrafts + p.hardErrorDrafts).toBe(p.totalDrafts);
  });

  it('handles empty input', () => {
    const result = runIntakePipeline([], CONFIG);
    expect(result.ready).toHaveLength(0);
    expect(result.intakeProgress.totalDrafts).toBe(0);
  });

  it('infers missing done for analysis-only tasks', () => {
    const result = runIntakePipeline([makeDraft({ prompt: 'summarize src/auth.ts', done: undefined })], CONFIG);
    expect(result.ready).toHaveLength(1);
  });
});