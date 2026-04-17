import { describe, it, expect, beforeEach } from 'vitest';
import { ClarificationStore } from '../../packages/core/src/intake/clarification-store.js';
import { processConfirmations } from '../../packages/core/src/intake/confirm.js';
import type { DraftTask, DelegateSource, ConfirmationEntry } from '../../packages/core/src/intake/types.js';

function makeDraft(draftId: string): DraftTask {
  return {
    draftId,
    source: { route: 'delegate_tasks', originalInput: {} } as DelegateSource,
    prompt: 'original',
  } as DraftTask;
}

describe('confirm', () => {
  let store: ClarificationStore;

  beforeEach(() => {
    store = new ClarificationStore();
  });

  it('returns error for missing clarification set', () => {
    const result = processConfirmations(store, 'nonexistent', new Map(), {});
    expect(result.errors.some(e => e.errorCode === 'clarification_not_found')).toBe(true);
  });

  it('confirms valid drafts and marks them confirmed', () => {
    const storedDraft = { draft: makeDraft('a:0:root'), taskIndex: 0, roundCount: 0 };
    const id = store.create([storedDraft], 'batch-1');
    const confirmations = new Map<string, ConfirmationEntry>([['a:0:root', { prompt: 'confirmed', done: 'done' }]]);
    const result = processConfirmations(store, id, confirmations, {});
    expect(result.confirmedDrafts).toHaveLength(1);
    expect(result.confirmedDrafts[0].prompt).toBe('confirmed');
    expect(result.confirmedDrafts[0].confirmed).toBe(true);
  });

  it('returns error for already-executed draft', () => {
    const storedDraft = { draft: makeDraft('a:0:root'), taskIndex: 0, roundCount: 0 };
    const id = store.create([storedDraft], 'batch-1');
    store.markExecuted(id, 'a:0:root');
    const confirmations = new Map([['a:0:root', { prompt: 'confirmed' }]]);
    const result = processConfirmations(store, id, confirmations, {});
    expect(result.errors.some(e => e.errorCode === 'draft_already_executed')).toBe(true);
  });

  it('rejects draft exceeding max rounds', () => {
    const storedDraft = { draft: makeDraft('a:0:root'), taskIndex: 0, roundCount: 3 };
    const id = store.create([storedDraft], 'batch-1');
    const confirmations = new Map([['a:0:root', { prompt: 'confirmed' }]]);
    const result = processConfirmations(store, id, confirmations, { maxRounds: 3 });
    expect(result.errors.some(e => e.errorCode === 'draft_refused')).toBe(true);
  });

  it('rejects empty prompt', () => {
    const storedDraft = { draft: makeDraft('a:0:root'), taskIndex: 0, roundCount: 0 };
    const id = store.create([storedDraft], 'batch-1');
    const confirmations = new Map([['a:0:root', { prompt: '' }]]);
    const result = processConfirmations(store, id, confirmations, {});
    expect(result.errors.some(e => e.errorCode === 'invalid_confirmation')).toBe(true);
  });
});