import { describe, it, expect } from 'vitest';
import { inferMissingFields } from '../../packages/core/src/intake/infer.js';
import type { DraftTask, DelegateSource } from '../../packages/core/src/intake/types.js';

function makeDraft(overrides: Partial<DraftTask> = {}): DraftTask {
  return {
    draftId: 'test:0:root',
    source: { route: 'delegate_tasks', originalInput: {} } as DelegateSource,
    prompt: 'summarize src/auth.ts',
    ...overrides,
  } as DraftTask;
}

describe('infer', () => {
  it('does not overwrite done when already set', () => {
    const draft = makeDraft({ done: 'summary returned' });
    const result = inferMissingFields(draft);
    expect(result.done).toBe('summary returned');
  });

  it('infers done for analysis-only short prompt', () => {
    const draft = makeDraft({ prompt: 'summarize src/auth.ts', done: undefined });
    const result = inferMissingFields(draft);
    expect(result.done).toBeDefined();
  });

  it('infers filePaths from prompt', () => {
    const draft = makeDraft({ prompt: 'review src/auth.ts and src/config.ts', filePaths: undefined });
    const result = inferMissingFields(draft);
    expect(result.filePaths).toContain('src/auth.ts');
    expect(result.filePaths).toContain('src/config.ts');
  });

  it('does not infer filePaths when already present', () => {
    const draft = makeDraft({ prompt: 'review src/auth.ts', filePaths: ['x.ts'] });
    const result = inferMissingFields(draft);
    expect(result.filePaths).toEqual(['x.ts']);
  });
});