import { randomUUID } from 'node:crypto';

/**
 * The handle a successful `register(...)` returns: the id a later dispatch references.
 *
 * It used to also carry `lengthChars` and a `sha256`, described here as letting a caller
 * "independently verify its content" — a capability no caller ever had. Both surfaces that
 * register a block (`POST /context-blocks` and the MCP tool) read `.id` and nothing else, so the
 * hash was computed on every registration and discarded. That is not free: the terminal block for
 * every read-route execution is the reviewer's raw output, and this file's own warning threshold
 * anticipates content over 10 MiB, which costs ~12ms to hash for no reader.
 */
export interface RegisteredBlock {
  id: string;
}

/**
 * Minimal store contract for reusable context blocks.
 *
 * The intent is to let a caller register a large brief once, then reference
 * it by id from many subsequent dispatches without re-transmitting the
 * content on every call. The unified handler resolves block IDs inline
 * and prepends the content to the worker payload.
 */
export interface ContextBlockStore {
  /** Store `content` under an explicit id (idempotent replace) or a new UUID. Returns the id. */
  register(content: string, opts?: { id?: string; ttlMs?: number }): RegisteredBlock;
  /** Fetch content by id. Returns `undefined` if the id is unknown or
   *  the entry has expired. Touches the LRU access time on success. */
  get(id: string): string | undefined;
  /** Delete an entry. Returns `true` if the entry existed. */
  delete(id: string): boolean;
  /** Number of entries. Used by status + size-cap checks. */
  readonly size: number;
  /** Increment pin count — holds blocks across an active task dispatch
   *  so they can't be evicted mid-run. */
  pin(id: string): void;
  /** Decrement pin count. */
  unpin(id: string): void;
  /** Current pin count for an entry. Returns 0 if unknown. */
  refcount(id: string): number;
  /** Wipe every entry. Used by project-registry on idle eviction. */
  clear(): void;
  /** Configured idle TTL (ms). Tests + observability surfaces read it. */
  readonly ttlMs: number;
}


interface Entry {
  content: string;
  addedAtMs: number;
  /** Per-entry TTL (4.2.3+ — A1.4 dedupe). When the caller supplies
   *  `opts.ttlMs` to register(), it is stored here and used by `get()`
   *  for the freshness check. Falls back to the class-level default
   *  (`_ttlMs`) when omitted, preserving prior behavior for callers
   *  that don't pass per-call TTL. */
  ttlMs: number;
  /** Monotonic access counter used for LRU ordering. Not wall-clock:
   *  `Date.now()` has millisecond resolution, which is too coarse for a
   *  sequence of synchronous register/get calls — multiple entries would
   *  tie at the same ms and the eviction order would become non-
   *  deterministic. A pure counter is strictly monotonic and unaffected
   *  by fake timers. */
  lastAccessTick: number;
  /** Reference count — incremented by pin(), decremented by unpin(). Pinned
   *  entries are excluded from LRU eviction. */
  pinCount: number;
}

export interface InMemoryContextBlockStoreOptions {
  /** Idle TTL in milliseconds. Defaults to 24 hours; resets on `get()`. */
  ttlMs?: number;
  /** Max number of entries before LRU eviction. Defaults to 500. */
  maxEntries?: number;
}

/**
 * In-memory implementation with two bounds:
 *   1. A TTL (time-to-live) from `addedAtMs` — checked lazily on `get`.
 *   2. An LRU cap on entry count — enforced eagerly after every `register`.
 *
 * Both bounds are intentional: the TTL prevents stale briefs from lingering
 * after a long-running session; the LRU cap prevents memory growth from a
 * chatty caller that never explicitly deletes anything. The eviction loop
 * is O(n) per insertion but `n <= maxEntries` (defaults to 500, matching
 * `server.limits.maxContextBlocksPerProject`), so we
 * keep the implementation simple.
 *
 * `Date.now()` is read directly (not through a clock abstraction) so tests
 * can drive time forward with Vitest's fake timers.
 */
export class InMemoryContextBlockStore implements ContextBlockStore {
  private entries = new Map<string, Entry>();
  private _ttlMs: number;
  private maxEntries: number;
  private tick = 0;

  constructor(opts: InMemoryContextBlockStoreOptions = {}) {
    this._ttlMs = opts.ttlMs ?? 24 * 60 * 60 * 1000;
    this.maxEntries = opts.maxEntries ?? 500;
  }

  register(content: string, opts: { id?: string; ttlMs?: number } = {}): RegisteredBlock {
    const id = opts.id ?? randomUUID();
    const byteSize = Buffer.byteLength(content, 'utf8');
    const SIZE_WARN_BYTES = 10 * 1024 * 1024;
    if (byteSize > SIZE_WARN_BYTES) {
      process.stderr.write(
        `[mma] WARN context-block ${id} is ${(byteSize / 1024 / 1024).toFixed(1)} MiB (>10 MiB)\n`,
      );
    }
    const now = Date.now();
    const entryTtl = opts.ttlMs ?? this._ttlMs;
    this.entries.set(id, { content, addedAtMs: now, ttlMs: entryTtl, lastAccessTick: ++this.tick, pinCount: 0 });
    this.evictIfOverBound();
    return { id };
  }

  get(id: string): string | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    const now = Date.now();
    if (now - entry.addedAtMs > entry.ttlMs) {
      // Expired — do not revive
      this.entries.delete(id);
      return undefined;
    }
    // LRU-refresh: extend TTL on access
    entry.addedAtMs = now;
    entry.lastAccessTick = ++this.tick;
    return entry.content;
  }

  delete(id: string): boolean {
    return this.entries.delete(id);
  }

  /** Increment the pin (reference) count for an entry. Pinned entries are
   *  skipped during LRU eviction. No-op if the entry is unknown. */
  pin(id: string): void {
    const entry = this.entries.get(id);
    if (entry) entry.pinCount += 1;
  }

  /** Decrement the pin count for an entry. No-op if the entry is unknown or
   *  the count is already zero. */
  unpin(id: string): void {
    const entry = this.entries.get(id);
    if (entry && entry.pinCount > 0) entry.pinCount -= 1;
  }

  /** Return the current pin count for an entry, or 0 if unknown. */
  refcount(id: string): number {
    return this.entries.get(id)?.pinCount ?? 0;
  }

  /** Idle TTL (ms) this store was configured with. */
  get ttlMs(): number {
    return this._ttlMs;
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  private evictIfOverBound(): void {
    while (this.entries.size > this.maxEntries) {
      let oldestId: string | undefined;
      let oldestTick = Infinity;
      for (const [id, entry] of this.entries) {
        // Skip pinned entries — held by active task dispatches
        if (entry.pinCount > 0) continue;
        if (entry.lastAccessTick < oldestTick) {
          oldestTick = entry.lastAccessTick;
          oldestId = id;
        }
      }
      if (oldestId) this.entries.delete(oldestId);
      else break; // all entries pinned — cannot evict
    }
  }
}
