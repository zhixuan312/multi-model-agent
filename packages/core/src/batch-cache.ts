import type { TaskSpec, RunResult } from './types.js';

export type BatchEntryStatus = 'pending' | 'complete' | 'aborted';

export interface BatchEntry {
  readonly tasks: TaskSpec[];
  status: BatchEntryStatus;
  results: RunResult[] | undefined;
  readonly expiresAt: number;
}

export interface BatchCacheOptions {
  ttlMs?: number;
  max?: number;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX = 100;

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

  complete(batchId: string, results: RunResult[]): void {
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

  get size(): number {
    return this.map.size;
  }
}
