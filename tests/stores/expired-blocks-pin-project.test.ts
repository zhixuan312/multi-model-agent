/**
 * An expired context block held a project slot forever.
 *
 * Expiry in `InMemoryContextBlockStore` is LAZY: an entry is dropped when `get` or `has` touches it
 * and finds it stale. Nothing sweeps. So a block that is registered, never read again, and then
 * ages past its TTL is unreachable through every read path — and `size` still counted it.
 *
 * `ProjectRegistry.evictIdleLRU` skips any project whose store is non-empty (`contextBlocks.size >
 * 0`), on the reasoning that a caller may still reference those blocks by id. Against a count that
 * included corpses, a project that registered one block and went quiet could never be evicted. Once
 * `cap` distinct cwds had each left one behind, `reserveProject` returned `project_cap` permanently
 * — the "permanent lockout" that method's own comment says it exists to prevent. A restart was the
 * only recovery.
 *
 * The same count gates `POST /context-blocks` (409 `cap_exhausted`) and is reported by `GET /status`
 * as `contextBlockCount`, so all three read a number that could not be reconciled with what `get`
 * would actually return.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { InMemoryContextBlockStore } from '../../packages/core/src/stores/context-block-tool.js';
import { ProjectRegistry } from '../../packages/server/src/application/project-registry.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

afterEach(() => {
  vi.useRealTimers();
});

describe('expired blocks are not counted as retained state', () => {
  it('size drops an entry once it is past its TTL', () => {
    vi.useFakeTimers();
    const store = new InMemoryContextBlockStore({ ttlMs: 1_000 });
    store.register('brief');
    expect(store.size, 'floor: the block must exist before expiry means anything').toBe(1);

    vi.advanceTimersByTime(1_001);
    // Unreachable through every read path...
    expect(store.get('nope')).toBeUndefined();
    // ...and no longer counted as retained state.
    expect(store.size).toBe(0);
  });

  it('a live entry is still counted, and its TTL still refreshes on read', () => {
    // Floor: the sweep must not have turned the store into a leaky sieve.
    vi.useFakeTimers();
    const store = new InMemoryContextBlockStore({ ttlMs: 1_000 });
    const { id } = store.register('brief');

    vi.advanceTimersByTime(900);
    expect(store.get(id)).toBe('brief'); // refreshes addedAtMs
    vi.advanceTimersByTime(900);
    expect(store.size, 'a block read within its TTL must survive').toBe(1);
    expect(store.get(id)).toBe('brief');
  });

  /**
   * LRU eviction orders by `lastAccessTick`, and expiry is per-entry (`register` takes a `ttlMs`).
   * Those two orderings can disagree: a block registered EARLIER can outlive one registered later.
   * When the bound is hit, evicting purely by tick then discards the live block and keeps the dead
   * one — the store ends up holding a corpse it will never hand back, having thrown away content a
   * caller could still have fetched. Reclaiming expired entries first makes room without that loss.
   */
  it('does not evict a live block to make room while a corpse holds a slot', () => {
    vi.useFakeTimers();
    const store = new InMemoryContextBlockStore({ maxEntries: 2 });
    const durable = store.register('durable', { ttlMs: 60_000 }); // older tick, long-lived
    store.register('short', { ttlMs: 1_000 });                     // newer tick, dies first

    vi.advanceTimersByTime(1_001); // `short` is now dead; `durable` has 59s left
    const fresh = store.register('fresh');

    expect(store.get(durable.id), 'the live block was evicted while the expired one was kept')
      .toBe('durable');
    expect(store.get(fresh.id)).toBe('fresh');
    expect(store.size).toBe(2);
  });
});

describe('a project holding only expired blocks can be evicted', () => {
  it('reserveProject does not lock out once the retained blocks are dead', () => {
    vi.useFakeTimers();
    const dirs = [1, 2, 3].map(() => mkdtempSync(join(tmpdir(), 'mma-pin-')));
    try {
      // cap 1 makes the lockout reachable in one step; production is the same shape at cap N.
      const registry = new ProjectRegistry({ cap: 1, contextBlocksPerProject: 10 });

      const first = registry.reserveProject(dirs[0]!);
      expect(first.ok, 'floor: the first project must be admitted').toBe(true);
      if (!first.ok) return;
      // A read-route terminal block: registered by the runtime, never fetched by the caller.
      first.projectContext.contextBlocks.register('terminal report');

      // While it is live the project is correctly retained — its blocks may still be referenced.
      const blocked = registry.reserveProject(dirs[1]!);
      expect(blocked.ok, 'a project with LIVE blocks must not be evicted').toBe(false);
      if (!blocked.ok) expect(blocked.error).toBe('project_cap');

      // 24h default TTL elapses. The block is now unreachable by any caller.
      vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1);

      const after = registry.reserveProject(dirs[2]!);
      expect(
        after.ok,
        'the slot stayed pinned by a block no caller could ever read again',
      ).toBe(true);
      expect(registry.size).toBe(1);
    } finally {
      for (const d of dirs) rmSync(d, { recursive: true, force: true });
    }
  });
});
