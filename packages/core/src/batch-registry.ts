export type BatchState = 'pending' | 'awaiting_clarification' | 'complete' | 'failed' | 'expired';

export function isTerminal(s: BatchState): boolean {
  return s === 'complete' || s === 'failed' || s === 'expired';
}

export interface BatchEntry<Result = unknown> {
  batchId: string;
  projectCwd: string;
  tool: string;
  state: BatchState;
  result?: Result;
  error?: { code: string; message: string; stack?: string };
  proposedInterpretation?: string;
  confirmedInterpretation?: string;
  resolveClarification?: (interpretation: string) => void;
  startedAt: number;
  stateChangedAt: number;
  blockIds: string[];
  blocksReleased: boolean;
  expiredAt?: number;
}

export interface BatchRegistryOptions {
  clarificationTimeoutMs?: number;
  batchTtlMs?: number;
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
      clarificationTimeoutMs: options.clarificationTimeoutMs ?? 24 * 60 * 60 * 1000,
      batchTtlMs: options.batchTtlMs ?? 60 * 60 * 1000,
    };
    this.deps = deps;
  }

  register(entry: BatchEntry): void {
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

  delete(batchId: string): boolean {
    return this.map.delete(batchId);
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

  requestClarification(batchId: string, proposal: string): void {
    const entry = this.map.get(batchId);
    if (!entry) return;
    if (entry.state !== 'pending') throw new InvalidBatchStateError(entry.state);
    entry.state = 'awaiting_clarification';
    entry.proposedInterpretation = proposal;
    entry.stateChangedAt = Date.now();
  }

  resumeFromClarification(batchId: string, interpretation: string): void {
    const entry = this.map.get(batchId);
    if (!entry) return;
    if (entry.state !== 'awaiting_clarification') {
      // idempotency: if already resumed with THIS interpretation, no-op
      if (entry.confirmedInterpretation === interpretation) return;
      throw new InvalidBatchStateError(entry.state);
    }
    entry.confirmedInterpretation = interpretation;
    entry.state = 'pending';
    entry.stateChangedAt = Date.now();
    const resolver = entry.resolveClarification;
    entry.resolveClarification = undefined;
    if (resolver) resolver(interpretation);
  }

  runClarificationTimeoutSweep(): void {
    const now = Date.now();
    for (const entry of this.map.values()) {
      if (
        entry.state === 'awaiting_clarification' &&
        now - entry.stateChangedAt > this.options.clarificationTimeoutMs
      ) {
        entry.state = 'failed';
        entry.error = { code: 'clarification_abandoned', message: 'Clarification not received within timeout' };
        entry.stateChangedAt = now;
        this.release(entry);
      }
    }
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
    if (entry.blocksReleased) return;
    if (this.deps.contextBlockStore) {
      for (const bid of entry.blockIds) {
        this.deps.contextBlockStore.unpin(bid);
      }
    }
    entry.blocksReleased = true;
  }
}
