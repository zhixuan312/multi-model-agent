import type { TaskSpec, RuntimeRunResult } from '../types.js';

export type BatchEntryStatus = 'pending' | 'complete' | 'aborted';

export interface BatchEntry {
  readonly tasks: TaskSpec[];
  status: BatchEntryStatus;
  results: RuntimeRunResult[] | undefined;
  readonly expiresAt: number;
}

export interface BatchCacheOptions {
  ttlMs?: number;
  max?: number;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX = 200;

export class BatchCache {
  private readonly map = new Map<string, BatchEntry>();
  private readonly ttlMs: number;
  private readonly max: number;

  constructor(options?: BatchCacheOptions) {
    this.ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
    this.max = options?.max ?? DEFAULT_MAX;
  }

  remember(batchId: string, tasks: TaskSpec[]): string {
    const entry: BatchEntry = {
      tasks,
      status: 'pending',
      results: undefined,
      expiresAt: Date.now() + this.ttlMs,
    };
    this.map.set(batchId, entry);
    while (this.map.size > this.max) {
      const lru = this.map.keys().next().value;
      if (lru === undefined) break;
      this.map.delete(lru);
    }
    return batchId;
  }

  complete(batchId: string, results: RuntimeRunResult[]): void {
    const entry = this.map.get(batchId);
    if (!entry) throw new Error(`batch "${batchId}" not found`);
    if (entry.status !== 'pending') {
      throw new Error(`batch "${batchId}" already ${entry.status}; cannot complete`);
    }
    entry.status = 'complete';
    entry.results = results;
  }

  abort(batchId: string): void {
    const entry = this.map.get(batchId);
    if (!entry) throw new Error(`batch "${batchId}" not found`);
    if (entry.status !== 'pending') {
      throw new Error(`batch "${batchId}" already ${entry.status}; cannot abort`);
    }
    entry.status = 'aborted';
  }

  get(batchId: string): BatchEntry | undefined {
    const entry = this.map.get(batchId);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      this.map.delete(batchId);
      return undefined;
    }
    return entry;
  }

  /** Re-inserts the entry at the tail of iteration order for LRU purposes. Does NOT refresh TTL. */
  touch(batchId: string): void {
    const entry = this.map.get(batchId);
    if (!entry) return;
    this.map.delete(batchId);
    this.map.set(batchId, entry);
  }

  clear(): void {
    this.map.clear();
  }

  /** Two-step retention: time-window prune (expired entries), then LRU prune to max. */
  prune(): void {
    const now = Date.now();
    // Step 1: time-window prune — drop entries past their expiresAt deadline
    for (const [key, entry] of this.map) {
      if (entry.expiresAt < now) {
        this.map.delete(key);
      }
    }
    // Step 2: LRU prune to max (Map iteration order = insertion order;
    // touch() re-inserts at the tail so live entries float, oldest at head)
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  get size(): number {
    return this.map.size;
  }
}
