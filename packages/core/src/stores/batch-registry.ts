import type { ToolCategory } from '../escalation/escalation-policy.js';

export type BatchState = 'pending' | 'complete' | 'failed' | 'expired';

export function isTerminal(s: BatchState): boolean {
  return s === 'complete' || s === 'failed' || s === 'expired';
}

export interface HeadlineSnapshot {
  /** Static prefix of the headline up to but not including the live elapsed slot.
   *  Example: `[3/5] Quality review (round 2/3, deepseek-v4-pro) — ` */
  prefix: string;
  /** Stats clause to append after live elapsed, or empty string when no counter
   *  has fired yet. Example: `, $0.10 saved (2.5x), 4 read, 1 tool call` */
  statsClause: string;
  /** ms since epoch — used to compute live elapsed at request time. */
  dispatchedAt: number;
  /** Optional fallback headline string for queue / pre-dispatch phases. */
  fallback: string;
}

/** Lightweight task spec stored in BatchRegistry entries for retry lookups. */
export interface RegistryTaskSpec {
  brief: string;
  cwd: string;
  agentType: 'standard' | 'complex';
  reviewPolicy: 'full' | 'quality_only' | 'diff_only' | 'none';
  contextBlockIds: string[];
}

// Input accepted by register() — runningHeadlineSnapshot OPTIONAL here so existing callers don't break.
export interface BatchEntryInput<Result = unknown> {
  batchId: string;
  projectCwd: string;
  tool: string;
  state: BatchState;
  result?: Result;
  error?: { code: string; message: string; stack?: string };
  startedAt: number;
  stateChangedAt: number;
  blockIds: string[];
  blocksReleased: boolean;
  expiredAt?: number;
  runningHeadlineSnapshot?: HeadlineSnapshot;
  tasksTotal?: number;
  tasksStarted?: number;
  tasksCompleted?: number;
  lastHeartbeatAt?: number;
  running?: Array<{ worker: string; turn: number }>;
  /** Tool category of the original request — populated for retry inheritance. */
  toolCategory?: ToolCategory;
  /** Original task specs — populated so retry slots can reconstruct briefs. */
  tasks?: RegistryTaskSpec[];
}

// Stored entry — runningHeadlineSnapshot REQUIRED.
export interface BatchEntry<Result = unknown> extends BatchEntryInput<Result> {
  runningHeadlineSnapshot: HeadlineSnapshot;
  /** taskIndex -> terminal context blockId; lazily created on first record */
  terminalBlockIds?: Map<number, string>;
}

export interface BatchRegistryOptions {
  batchTtlMs?: number;
  max?: number;
}

export interface BatchRegistryDeps {
  contextBlockStore?: {
    pin(id: string): void;
    unpin(id: string): void;
  };
}

export class InvalidBatchStateError extends Error {
  constructor(public currentState: BatchState) {
    super(`invalid_batch_state: currently ${currentState}`);
    this.name = 'InvalidBatchStateError';
  }
}

export class BatchRegistry {
  private map = new Map<string, BatchEntry>();
  private options: Required<BatchRegistryOptions>;
  private deps: BatchRegistryDeps;

  constructor(options: BatchRegistryOptions = {}, deps: BatchRegistryDeps = {}) {
    this.options = {
      batchTtlMs: options.batchTtlMs ?? 60 * 60 * 1000,
      max: options.max ?? 200,
    };
    this.deps = deps;
  }

  register(input: BatchEntryInput): void {
    if (!input.runningHeadlineSnapshot) {
      const N = input.tasksTotal ?? 1;
      input.runningHeadlineSnapshot = {
        prefix: '',
        statsClause: '',
        dispatchedAt: Date.now(),
        fallback: `0/${N} queued`,
      };
    }
    const entry = input as BatchEntry;
    this.map.set(entry.batchId, entry);
    if (this.deps.contextBlockStore) {
      for (const bid of entry.blockIds) {
        this.deps.contextBlockStore.pin(bid);
      }
    }
  }

  get(batchId: string): BatchEntry | undefined {
    return this.map.get(batchId);
  }

  updateRunningHeadlineSnapshot(batchId: string, snapshot: HeadlineSnapshot): void {
    const entry = this.map.get(batchId);
    if (!entry) return;
    if (isTerminal(entry.state)) return;
    entry.runningHeadlineSnapshot = snapshot;
  }

  delete(batchId: string): boolean {
    return this.map.delete(batchId);
  }

  recordTerminalBlock(batchId: string, taskIndex: number, blockId: string): void {
    const entry = this.map.get(batchId);
    if (!entry) throw new Error(`unknown batchId: ${batchId}`);
    if (!entry.terminalBlockIds) entry.terminalBlockIds = new Map();
    entry.terminalBlockIds.set(taskIndex, blockId);
  }

  getTerminalBlock(batchId: string, taskIndex: number): string | undefined {
    return this.map.get(batchId)?.terminalBlockIds?.get(taskIndex);
  }

  size(): number {
    return this.map.size;
  }

  entries(): IterableIterator<BatchEntry> {
    return this.map.values();
  }

  complete<R>(batchId: string, result: R): void {
    const entry = this.map.get(batchId);
    if (!entry) return;
    if (isTerminal(entry.state)) return; // idempotent
    entry.state = 'complete';
    entry.result = result;
    entry.stateChangedAt = Date.now();
    this.release(entry);
  }

  fail(batchId: string, error: { code: string; message: string; stack?: string }): void {
    const entry = this.map.get(batchId);
    if (!entry) return;
    if (isTerminal(entry.state)) return; // idempotent
    entry.state = 'failed';
    entry.error = error;
    entry.stateChangedAt = Date.now();
    this.release(entry);
  }

  runExpirySweep(): void {
    const now = Date.now();
    const toDelete: string[] = [];
    for (const entry of this.map.values()) {
      if (entry.state === 'expired') {
        // second-pass: delete entries that were already marked expired
        toDelete.push(entry.batchId);
      } else if (
        (entry.state === 'complete' || entry.state === 'failed') &&
        now - entry.stateChangedAt > this.options.batchTtlMs
      ) {
        // first-pass: transition terminal entries to expired
        entry.state = 'expired';
        entry.expiredAt = now;
        entry.stateChangedAt = now;
        this.release(entry);
      }
    }
    for (const batchId of toDelete) {
      this.map.delete(batchId);
    }
  }

  /** Two-step retention: time-window prune (expired + stale terminal entries), then LRU prune to max.
   *
   * Step 1 expired branch relies on runExpirySweep() having already called release()
   * during the transition into expired — so no release call here. */
  prune(): void {
    const now = Date.now();
    // Step 1: time-window prune — drop expired entries and stale terminal entries
    for (const [key, entry] of this.map) {
      if (entry.state === 'expired') {
        // release() was already called by runExpirySweep() during the complete/failed → expired transition
        this.map.delete(key);
      } else if (
        (entry.state === 'complete' || entry.state === 'failed') &&
        now - entry.stateChangedAt > this.options.batchTtlMs
      ) {
        this.release(entry);
        this.map.delete(key);
      }
    }
    // Step 2: LRU prune to max (Map iteration order = insertion order;
    // oldest entries at head are evicted first)
    while (this.map.size > this.options.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      const entry = this.map.get(oldest);
      if (entry) this.release(entry);
      this.map.delete(oldest);
    }
  }

  countActiveForProject(cwd: string): number {
    let count = 0;
    for (const entry of this.map.values()) {
      if (entry.projectCwd === cwd && !isTerminal(entry.state)) {
        count++;
      }
    }
    return count;
  }

  private release(entry: BatchEntry): void {
    entry.runningHeadlineSnapshot = { prefix: '', statsClause: '', dispatchedAt: 0, fallback: '' };
    entry.tasksTotal = undefined;
    entry.tasksStarted = undefined;
    entry.tasksCompleted = undefined;
    entry.lastHeartbeatAt = undefined;
    entry.running = undefined;
    if (entry.blocksReleased) return;
    if (this.deps.contextBlockStore) {
      for (const bid of entry.blockIds) {
        this.deps.contextBlockStore.unpin(bid);
      }
    }
    entry.blocksReleased = true;
  }
}
