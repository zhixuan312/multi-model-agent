import { describe, it, expect } from 'vitest';
import { classifyDraft } from '../../packages/core/src/intake/classify.js';
import type { DraftTask, DelegateSource } from '../../packages/core/src/intake/types.js';

function makeDraft(overrides: Partial<DraftTask> = {}): DraftTask {
  return {
    draftId: 'test:0:root',
    source: { route: 'delegate_tasks', originalInput: {} } as DelegateSource,
    prompt: 'reply with hello',
    ...overrides,
  } as DraftTask;
}

describe('classify', () => {
  it('returns ready for clear task with done condition', () => {
    const result = classifyDraft(makeDraft({ done: 'greeting returned' }));
    expect(result.classification).toBe('ready');
  });

  it('returns needs_confirmation for vague delegate prompt', () => {
    const result = classifyDraft(makeDraft({ prompt: 'fix it', done: undefined }));
    expect(result.classification).toBe('needs_confirmation');
  });

  it('returns unrecoverable for empty prompt', () => {
    const result = classifyDraft(makeDraft({ prompt: '' }));
    expect(result.classification).toBe('unrecoverable');
  });

  it('returns unrecoverable for single-word prompt', () => {
    const result = classifyDraft(makeDraft({ prompt: 'fix' }));
    expect(result.classification).toBe('unrecoverable');
  });

  it('returns needs_confirmation when draft has open questions', () => {
    const result = classifyDraft(makeDraft({ questions: ['which file?'] }));
    expect(result.classification).toBe('needs_confirmation');
  });

  it('returns ready for confirmed draft', () => {
    const result = classifyDraft(makeDraft({ confirmed: true, prompt: 'fix it' }));
    expect(result.classification).toBe('ready');
  });

  it('returns ready for 2-word prompt that passes vague pattern check', () => {
    const result = classifyDraft(makeDraft({ prompt: 'please help', done: undefined }));
    expect(result.classification).toBe('ready');
  });
});