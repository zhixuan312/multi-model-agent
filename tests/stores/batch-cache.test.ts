import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BatchCache } from '../../packages/core/src/stores/batch-cache.js';
import type { TaskSpec, RuntimeRunResult } from '../../packages/core/src/types.js';

const specs = (n: number): TaskSpec[] => Array.from({ length: n }, (_, i) => ({
  prompt: `task ${i}`,
  agentType: 'standard',
  tools: 'full',
  timeoutMs: 60_000,
  sandboxPolicy: 'cwd-only',
  cwd: '/tmp',
  reviewPolicy: 'reviewed',
  effort: undefined,
  mainModel: undefined,
} as TaskSpec));

const result = (status: RuntimeRunResult['status'] = 'ok'): RuntimeRunResult => ({
  status,
  output: 'x',
  filesWritten: [],
  durationMs: 100,
});

describe('BatchCache', () => {
  let cache: BatchCache;
  beforeEach(() => { cache = new BatchCache({ ttlMs: 1000, max: 3 }); });

  it('remember() creates a pending entry', () => {
    const id = '00000000-0000-0000-0000-000000000001';
    const ret = cache.remember(id, specs(1));
    const entry = cache.get(id);
    expect(ret).toBe(id);
    expect(entry).toBeDefined();
    expect(entry!.status).toBe('pending');
    expect(entry!.results).toBeUndefined();
    expect(entry!.tasks.length).toBe(1);
  });

  it('uses caller-supplied batchId, does not mint its own', () => {
    const cache = new BatchCache();
    const id = '11111111-1111-1111-1111-111111111111';
    const ret = cache.remember(id, []);
    expect(ret).toBe(id);
    expect(cache.get(id)).toBeDefined();
  });

  it('complete() transitions pending → complete and stores results', () => {
    const id = '00000000-0000-0000-0000-000000000002';
    cache.remember(id, specs(1));
    cache.complete(id, [result()]);
    const entry = cache.get(id)!;
    expect(entry.status).toBe('complete');
    expect(entry.results).toHaveLength(1);
  });

  it('abort() transitions pending → aborted; results stays undefined', () => {
    const id = '00000000-0000-0000-0000-000000000003';
    cache.remember(id, specs(1));
    cache.abort(id);
    const entry = cache.get(id)!;
    expect(entry.status).toBe('aborted');
    expect(entry.results).toBeUndefined();
  });

  it('complete() on already-terminal entry throws', () => {
    const id = '00000000-0000-0000-0000-000000000004';
    cache.remember(id, specs(1));
    cache.complete(id, [result()]);
    expect(() => cache.complete(id, [result()])).toThrow(/already/i);
  });

  it('abort() on already-terminal entry throws', () => {
    const id = '00000000-0000-0000-0000-000000000005';
    cache.remember(id, specs(1));
    cache.abort(id);
    expect(() => cache.abort(id)).toThrow(/already/i);
  });

  it('get() on expired entry returns undefined and evicts it', () => {
    vi.useFakeTimers();
    const t0 = Date.now();
    vi.setSystemTime(t0);
    const id = '00000000-0000-0000-0000-000000000006';
    cache.remember(id, specs(1));
    vi.setSystemTime(t0 + 1001);
    expect(cache.get(id)).toBeUndefined();
    // Second call still undefined (entry was dropped)
    expect(cache.get(id)).toBeUndefined();
    vi.useRealTimers();
  });

  it('touch() moves entry to LRU tail without refreshing TTL', () => {
    vi.useFakeTimers();
    const t0 = Date.now();
    vi.setSystemTime(t0);
    const a = '00000000-0000-0000-0000-000000000007';
    const b = '00000000-0000-0000-0000-000000000008';
    const c = '00000000-0000-0000-0000-000000000009';
    const d = '00000000-0000-0000-0000-000000000010';
    cache.remember(a, specs(1));
    cache.remember(b, specs(1));
    cache.remember(c, specs(1));
    cache.touch(a); // a is now most-recent
    cache.remember(d, specs(1)); // forces eviction of LRU head; b should go, not a
    expect(cache.get(a)).toBeDefined();
    expect(cache.get(b)).toBeUndefined();
    expect(cache.get(c)).toBeDefined();
    vi.setSystemTime(t0 + 1001);
    expect(cache.get(a)).toBeUndefined(); // TTL was not refreshed
    vi.useRealTimers();
  });

  it('clear() empties the cache', () => {
    const id = '00000000-0000-0000-0000-000000000011';
    cache.remember(id, specs(1));
    cache.clear();
    expect(cache.get(id)).toBeUndefined();
  });
});

describe('BatchCache two-step retention', () => {
  it('time-window prune removes stale entries first', () => {
    vi.useFakeTimers();
    const t0 = Date.now();
    vi.setSystemTime(t0);
    const cache = new BatchCache({ ttlMs: 1000, max: 10 });
    const id = '00000000-0000-0000-0000-000000000012';
    cache.remember(id, specs(1));
    vi.setSystemTime(t0 + 2000);
    cache.prune();
    expect(cache.get(id)).toBeUndefined();
    vi.useRealTimers();
  });

  it('LRU prune fires only after time-window leaves >max', () => {
    const cache = new BatchCache({ ttlMs: 24 * 60 * 60 * 1000, max: 200 });
    for (let i = 0; i < 250; i++) {
      cache.remember(`k${i}`, specs(1));
    }
    cache.prune();
    expect(cache.size).toBe(200);
    // Oldest 50 evicted (k0..k49)
    expect(cache.get('k0')).toBeUndefined();
    expect(cache.get('k49')).toBeUndefined();
    expect(cache.get('k50')).toBeDefined();
  });

  it('time-window removes expired entries before LRU, preserving recent ones', () => {
    vi.useFakeTimers();
    const t0 = Date.now();
    vi.setSystemTime(t0);
    const cache = new BatchCache({ ttlMs: 1000, max: 5 });
    // Insert 3 fresh entries
    cache.remember('fresh1', specs(1));
    cache.remember('fresh2', specs(1));
    cache.remember('fresh3', specs(1));
    // Advance time past TTL
    vi.setSystemTime(t0 + 2000);
    // Insert 2 more fresh entries — these get fresh expiresAt
    cache.remember('fresh4', specs(1));
    cache.remember('fresh5', specs(1));
    // Now insert 3 more to trigger over-max: total 8, but 3 old ones should be pruned by time-window first
    cache.remember('extra1', specs(1));
    cache.remember('extra2', specs(1));
    cache.remember('extra3', specs(1));

    cache.prune();
    // Time-window step drops fresh1,fresh2,fresh3 (expired). That leaves 5 entries
    // (fresh4,fresh5,extra1,extra2,extra3) at max=5, so LRU fires 0 evictions.
    expect(cache.size).toBe(5);
    expect(cache.get('fresh1')).toBeUndefined();
    expect(cache.get('fresh2')).toBeUndefined();
    expect(cache.get('fresh3')).toBeUndefined();
    expect(cache.get('fresh4')).toBeDefined();
    expect(cache.get('fresh5')).toBeDefined();
    vi.useRealTimers();
  });
});
