import { createHash, randomUUID } from 'node:crypto';

/**
 * Metadata describing a successful `register(...)` call. The orchestrator
 * and MCP tool surfaces return this to the caller so they can reference
 * the stored block later (by id) and independently verify its content
 * (via sha256).
 */
export interface RegisteredBlock {
  id: string;
  lengthChars: number;
  sha256: string;
}

/**
 * Minimal store contract for reusable context blocks.
 *
 * The intent is to let a caller register a large brief once, then reference
 * it by id from many subsequent dispatches without re-transmitting the
 * content on every call. See `expandContextBlocks` for the resolution
 * step that turns `TaskSpec.contextBlockIds` into prompt text.
 */
export interface ContextBlockStore {
  /** Store `content` under an explicit id (idempotent replace) or a new
   *  UUID. Returns the id, length, and sha256 hash. */
  register(content: string, opts?: { id?: string }): RegisteredBlock;
  /** Fetch content by id. Returns `undefined` if the id is unknown or
   *  the entry has expired. Touches the LRU access time on success. */
  get(id: string): string | undefined;
  /** Delete an entry. Returns `true` if the entry existed. */
  delete(id: string): boolean;
}

/**
 * Thrown by `expandContextBlocks` when a task references a block id that
 * cannot be resolved against the store (missing, expired, or evicted).
 * Callers are expected to surface this to the user so they can re-register
 * the block and retry.
 */
export class ContextBlockNotFoundError extends Error {
  constructor(public readonly id: string) {
    super(
      `Context block "${id}" is unknown or expired. ` +
      `Retry without contextBlockIds for a full (non-delta) run, ` +
      `or re-register the content via register_context_block and retry with the new ID.`,
    );
    this.name = 'ContextBlockNotFoundError';
  }
}

interface Entry {
  content: string;
  addedAtMs: number;
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
  /** TTL in milliseconds. Defaults to 30 minutes. */
  ttlMs?: number;
  /** Max number of entries before LRU eviction. Defaults to 100. */
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
 * is O(n) per insertion but `n <= maxEntries` (defaults to 100), so we
 * keep the implementation simple.
 *
 * `Date.now()` is read directly (not through a clock abstraction) so tests
 * can drive time forward with Vitest's fake timers.
 */
export class InMemoryContextBlockStore implements ContextBlockStore {
  private entries = new Map<string, Entry>();
  private ttlMs: number;
  private maxEntries: number;
  private tick = 0;

  constructor(opts: InMemoryContextBlockStoreOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 30 * 60 * 1000;
    this.maxEntries = opts.maxEntries ?? 100;
  }

  register(content: string, opts: { id?: string } = {}): RegisteredBlock {
    const id = opts.id ?? randomUUID();
    const now = Date.now();
    this.entries.set(id, { content, addedAtMs: now, lastAccessTick: ++this.tick, pinCount: 0 });
    this.evictIfOverBound();
    return {
      id,
      lengthChars: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
    };
  }

  get(id: string): string | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    const now = Date.now();
    if (now - entry.addedAtMs > this.ttlMs) {
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
        // Skip pinned entries — they are held by active BatchRegistry entries
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
