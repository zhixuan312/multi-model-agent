import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  InMemoryContextBlockStore,
} from '../../packages/core/src/stores/context-block-tool.js';

describe('InMemoryContextBlockStore — basic CRUD', () => {
  it('register-with-id stores content under that id', () => {
    const store = new InMemoryContextBlockStore();
    const result = store.register('hello world', { id: 'greeting' });
    expect(result.id).toBe('greeting');
    expect(store.get('greeting')).toBe('hello world');
  });

  it('register-without-id generates a UUID', () => {
    const store = new InMemoryContextBlockStore();
    const result = store.register('content');
    expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(store.get(result.id)).toBe('content');
  });

  it('idempotent re-register under the same id replaces content', () => {
    const store = new InMemoryContextBlockStore();
    store.register('first', { id: 'x' });
    store.register('second', { id: 'x' });
    expect(store.get('x')).toBe('second');
  });

  it('get returns undefined for unknown id', () => {
    const store = new InMemoryContextBlockStore();
    expect(store.get('unknown')).toBeUndefined();
  });

  it('delete returns true if id existed', () => {
    const store = new InMemoryContextBlockStore();
    store.register('content', { id: 'x' });
    expect(store.delete('x')).toBe(true);
    expect(store.delete('x')).toBe(false);
  });

  it('register returns the id and nothing a caller cannot use', () => {
    // `lengthChars` and `sha256` were removed: both surfaces that register a block read `.id`
    // only, so the hash was computed over content up to 10 MiB and thrown away on every
    // read-route completion. This case now pins the handle's SHAPE, so re-adding a field means
    // deciding who reads it.
    const store = new InMemoryContextBlockStore();
    const result = store.register('hello');
    expect(Object.keys(result)).toEqual(['id']);
  });
});

describe('InMemoryContextBlockStore — TTL eviction', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('evicts entries after TTL expires without access', () => {
    const store = new InMemoryContextBlockStore({ ttlMs: 60_000 });
    store.register('content', { id: 'x' });
    // Don't access — just let TTL expire
    vi.advanceTimersByTime(61_000);
    expect(store.get('x')).toBeUndefined();
  });

  it('access refreshes TTL so entry survives past original expiry', () => {
    const store = new InMemoryContextBlockStore({ ttlMs: 60_000 });
    store.register('content', { id: 'x' });
    vi.advanceTimersByTime(30_000);
    expect(store.get('x')).toBe('content'); // refreshes TTL
    vi.advanceTimersByTime(31_000); // 31s after refresh, still within 60s TTL
    expect(store.get('x')).toBe('content'); // still alive
    vi.advanceTimersByTime(61_000); // now past refreshed TTL
    expect(store.get('x')).toBeUndefined();
  });
});

describe('InMemoryContextBlockStore — LRU eviction', () => {
  it('evicts least-recently-used when bound is exceeded', () => {
    const store = new InMemoryContextBlockStore({ maxEntries: 3 });
    store.register('a', { id: 'a' });
    store.register('b', { id: 'b' });
    store.register('c', { id: 'c' });
    store.get('a'); // touch a, making b the LRU
    store.register('d', { id: 'd' }); // should evict b
    expect(store.get('a')).toBe('a');
    expect(store.get('b')).toBeUndefined();
    expect(store.get('c')).toBe('c');
    expect(store.get('d')).toBe('d');
  });
});

describe('LRU TTL refresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refreshes TTL on access (non-expired block stays alive longer)', () => {
    const store = new InMemoryContextBlockStore({ ttlMs: 100 });
    const { id } = store.register('content');

    // Advance time to 80ms (not expired yet)
    vi.advanceTimersByTime(80);
    const result1 = store.get(id);
    expect(result1).toBe('content'); // still alive, TTL refreshed

    // Advance another 80ms (160ms total, but TTL was refreshed at 80ms)
    vi.advanceTimersByTime(80);
    const result2 = store.get(id);
    expect(result2).toBe('content'); // still alive because TTL was refreshed

    // Advance past refreshed TTL
    vi.advanceTimersByTime(120);
    const result3 = store.get(id);
    expect(result3).toBeUndefined(); // now expired
  });

  it('does not revive already-expired blocks', () => {
    const store = new InMemoryContextBlockStore({ ttlMs: 100 });
    const { id } = store.register('content');

    vi.advanceTimersByTime(150); // past TTL
    const result = store.get(id);
    expect(result).toBeUndefined(); // expired, not revived
  });
});

describe('InMemoryContextBlockStore — v4.0 defaults', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('default TTL is 24 hours idle', () => {
    const store = new InMemoryContextBlockStore();
    store.register('content', { id: 'a' });
    // 23 hours later — still within default 24h TTL
    vi.advanceTimersByTime(23 * 60 * 60 * 1000);
    expect(store.get('a')).toBe('content');
  });

  it('default TTL resets on get()', () => {
    const store = new InMemoryContextBlockStore();
    store.register('content', { id: 'a' });
    // 23 hours later, get resets the idle timer
    vi.advanceTimersByTime(23 * 60 * 60 * 1000);
    expect(store.get('a')).toBe('content');
    // Another 23 hours — still alive because timer was reset
    vi.advanceTimersByTime(23 * 60 * 60 * 1000);
    expect(store.get('a')).toBe('content');
  });

  it('evicts after 24h idle without access', () => {
    const store = new InMemoryContextBlockStore();
    store.register('content', { id: 'a' });
    vi.advanceTimersByTime(25 * 60 * 60 * 1000);
    expect(store.get('a')).toBeUndefined();
  });

  it('default maxEntries is 500', () => {
    const store = new InMemoryContextBlockStore();
    for (let i = 0; i < 500; i++) store.register('x', { id: `k${i}` });
    expect(store.size).toBe(500);
    store.register('y', { id: 'k500' });
    expect(store.size).toBe(500); // LRU evicted oldest
    expect(store.get('k0')).toBeUndefined();
  });

  it('emits warning when entry exceeds 10 MiB', () => {
    const warns: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: typeof process.stderr.write }).write = ((
      chunk: string | Uint8Array,
    ) => {
      warns.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stderr.write;
    const store = new InMemoryContextBlockStore();
    store.register('x'.repeat(11 * 1024 * 1024), { id: 'big' });
    process.stderr.write = orig;
    expect(warns.some((w) => w.includes('>10 MiB'))).toBe(true);
  });
});

/**
 * `has` exists so an existence question does not become a liveness grant.
 *
 * `get` refreshes TTL and LRU position on purpose — that is right for a caller that wants the
 * content. The delete handler used it to answer "does this block exist?", so a DELETE rejected as
 * `pinned` renewed the very block it failed to remove and promoted it to newest in LRU order.
 */
describe('InMemoryContextBlockStore — has() does not touch TTL or LRU', () => {
  it('reports existence without refreshing the TTL', () => {
    vi.useFakeTimers();
    try {
      const store = new InMemoryContextBlockStore({ ttlMs: 1_000 });
      store.register('content', { id: 'a' });

      vi.advanceTimersByTime(900);
      expect(store.has('a')).toBe(true);

      // Had `has` refreshed the entry the way `get` does, this would still be live.
      vi.advanceTimersByTime(200);
      expect(store.has('a'), 'has() renewed the TTL').toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not promote an entry in LRU order', () => {
    const store = new InMemoryContextBlockStore({ maxEntries: 2 });
    store.register('first', { id: 'a' });
    store.register('second', { id: 'b' });

    // Asking about `a` must not save it from eviction.
    expect(store.has('a')).toBe(true);
    store.register('third', { id: 'c' });

    expect(store.has('a'), 'has() promoted the oldest entry and evicted the wrong one').toBe(false);
    expect(store.has('b')).toBe(true);
    expect(store.has('c')).toBe(true);
  });

  it('reports an expired entry as absent, like get', () => {
    vi.useFakeTimers();
    try {
      const store = new InMemoryContextBlockStore({ ttlMs: 100 });
      store.register('gone', { id: 'x' });
      vi.advanceTimersByTime(101);
      expect(store.has('x')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports an unknown id as absent', () => {
    expect(new InMemoryContextBlockStore().has('nope')).toBe(false);
  });
});
