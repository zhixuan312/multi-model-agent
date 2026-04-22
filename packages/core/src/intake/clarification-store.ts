import { randomUUID } from 'node:crypto';
import type { ClarificationSet, StoredDraft } from './types.js';

export interface ClarificationStoreOptions {
  ttlMs?: number;
  maxSets?: number;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_SETS = 100;

export class ClarificationStore {
  private readonly sets = new Map<string, ClarificationSet>();
  private readonly ttlMs: number;
  private readonly maxSets: number;

  constructor(options?: ClarificationStoreOptions) {
    this.ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
    this.maxSets = options?.maxSets ?? DEFAULT_MAX_SETS;
  }

  create(storedDrafts: StoredDraft[], originalBatchId: string): string {
    const id = randomUUID();
    const now = Date.now();
    const drafts = new Map<string, StoredDraft>();
    for (const sd of storedDrafts) {
      drafts.set(sd.draft.draftId, sd);
    }
    this.sets.set(id, {
      id,
      drafts,
      originalBatchId,
      executedDraftIds: new Set(),
      createdAt: now,
      lastAccessedAt: now,
    });
    this.evict();
    return id;
  }

  get(id: string): ClarificationSet | undefined {
    const set = this.sets.get(id);
    if (!set) return undefined;
    if (Date.now() - set.lastAccessedAt > this.ttlMs) {
      this.sets.delete(id);
      return undefined;
    }
    this.sets.delete(id);
    this.sets.set(id, set);
    return set;
  }

  touchForConfirm(id: string): void {
    const set = this.sets.get(id);
    if (set) {
      set.lastAccessedAt = Date.now();
    }
  }

  removeDraft(setId: string, draftId: string): void {
    const set = this.sets.get(setId);
    if (!set) return;
    set.drafts.delete(draftId);
    if (set.drafts.size === 0 && set.executedDraftIds.size === 0) {
      this.sets.delete(setId);
    }
  }

  markExecuted(setId: string, draftId: string): void {
    const set = this.sets.get(setId);
    if (!set) return;
    set.executedDraftIds.add(draftId);
    set.drafts.delete(draftId);
  }

  cleanupIfResolved(setId: string): void {
    const set = this.sets.get(setId);
    if (set && set.drafts.size === 0) {
      this.sets.delete(setId);
    }
  }

  incrementRound(setId: string, draftId: string): void {
    const set = this.sets.get(setId);
    if (!set) return;
    const stored = set.drafts.get(draftId);
    if (stored) {
      stored.roundCount++;
    }
  }

  delete(id: string): boolean {
    return this.sets.delete(id);
  }

  clear(): void {
    this.sets.clear();
  }

  private evict(): void {
    let unresolvedCount = 0;
    for (const set of this.sets.values()) {
      if (set.drafts.size > 0) unresolvedCount++;
    }
    if (unresolvedCount <= this.maxSets) return;

    for (const [id, set] of this.sets) {
      if (unresolvedCount <= this.maxSets) break;
      if (set.drafts.size > 0) {
        this.sets.delete(id);
        unresolvedCount--;
      }
    }
  }
}