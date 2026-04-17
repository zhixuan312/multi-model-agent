import { describe, it, expect, beforeEach } from 'vitest';
import { ClarificationStore } from '../../packages/core/src/intake/clarification-store.js';
import type { StoredDraft, DraftTask, DelegateSource } from '../../packages/core/src/intake/types.js';

function makeStoredDraft(draftId: string): StoredDraft {
  return {
    draft: {
      draftId,
      source: { route: 'delegate_tasks', originalInput: {} } as DelegateSource,
      prompt: 'task ' + draftId,
    } as DraftTask,
    taskIndex: 0,
    roundCount: 0,
  };
}

describe('clarification-store', () => {
  let store: ClarificationStore;

  beforeEach(() => {
    store = new ClarificationStore({ ttlMs: 1000, maxSets: 3 });
  });

  it('creates a set and returns an id', () => {
    const id = store.create([makeStoredDraft('a:0:root')], 'batch-1');
    expect(typeof id).toBe('string');
    const set = store.get(id);
    expect(set).toBeDefined();
    expect(set!.originalBatchId).toBe('batch-1');
  });

  it('returns undefined for expired set', async () => {
    const store2 = new ClarificationStore({ ttlMs: 10, maxSets: 3 });
    const id = store2.create([makeStoredDraft('a:0:root')], 'batch-1');
    await new Promise(r => setTimeout(r, 20));
    expect(store2.get(id)).toBeUndefined();
  });

  it('evicts oldest when maxSets exceeded', () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(store.create([makeStoredDraft(`a:${i}:root`)], `batch-${i}`));
    }
    const oldest = store.get(ids[0]);
    expect(oldest).toBeUndefined();
    const newest = store.get(ids[4]);
    expect(newest).toBeDefined();
  });

  it('marks draft as executed and removes from drafts', () => {
    const id = store.create([makeStoredDraft('a:0:root')], 'batch-1');
    store.markExecuted(id, 'a:0:root');
    const set = store.get(id);
    expect(set!.drafts.has('a:0:root')).toBe(false);
    expect(set!.executedDraftIds.has('a:0:root')).toBe(true);
  });

  it('removes draft and cleans up if resolved', () => {
    const id = store.create([makeStoredDraft('a:0:root')], 'batch-1');
    store.markExecuted(id, 'a:0:root');
    store.cleanupIfResolved(id);
    expect(store.get(id)).toBeUndefined();
  });

  it('increments round count', () => {
    const id = store.create([makeStoredDraft('a:0:root')], 'batch-1');
    store.incrementRound(id, 'a:0:root');
    const set = store.get(id);
    expect(set!.drafts.get('a:0:root')!.roundCount).toBe(1);
  });

  it('deletes set', () => {
    const id = store.create([makeStoredDraft('a:0:root')], 'batch-1');
    expect(store.delete(id)).toBe(true);
    expect(store.get(id)).toBeUndefined();
  });
});