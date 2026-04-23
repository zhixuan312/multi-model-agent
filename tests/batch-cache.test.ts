import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BatchCache } from '../packages/core/src/batch-cache.js';
import type { TaskSpec, RunResult } from '../packages/core/src/types.js';

const specs = (n: number): TaskSpec[] => Array.from({ length: n }, (_, i) => ({
  prompt: `task ${i}`,
  agentType: 'standard',
  tools: 'full',
  timeoutMs: 60_000,
  maxCostUSD: 1,
  sandboxPolicy: 'cwd-only',
  cwd: '/tmp',
  reviewPolicy: 'full',
  effort: undefined,
  parentModel: undefined,
  autoCommit: true,
} as TaskSpec));

const result = (status: RunResult['status'] = 'ok'): RunResult => ({
  status,
  output: 'x',
  filesWritten: [],
  durationMs: 100,
});

describe('BatchCache', () => {
  let cache: BatchCache;
  beforeEach(() => { cache = new BatchCache({ ttlMs: 1000, max: 3 }); });

  it('remember() creates a pending entry', () => {
    const id = cache.remember(specs(1));
    const entry = cache.get(id);
    expect(entry).toBeDefined();
    expect(entry!.status).toBe('pending');
    expect(entry!.results).toBeUndefined();
    expect(entry!.tasks.length).toBe(1);
  });

  it('complete() transitions pending → complete and stores results', () => {
    const id = cache.remember(specs(1));
    cache.complete(id, [result()]);
    const entry = cache.get(id)!;
    expect(entry.status).toBe('complete');
    expect(entry.results).toHaveLength(1);
  });

  it('abort() transitions pending → aborted; results stays undefined', () => {
    const id = cache.remember(specs(1));
    cache.abort(id);
    const entry = cache.get(id)!;
    expect(entry.status).toBe('aborted');
    expect(entry.results).toBeUndefined();
  });

  it('complete() on already-terminal entry throws', () => {
    const id = cache.remember(specs(1));
    cache.complete(id, [result()]);
    expect(() => cache.complete(id, [result()])).toThrow(/already/i);
  });

  it('abort() on already-terminal entry throws', () => {
    const id = cache.remember(specs(1));
    cache.abort(id);
    expect(() => cache.abort(id)).toThrow(/already/i);
  });

  it('get() on expired entry returns undefined and evicts it', () => {
    vi.useFakeTimers();
    const t0 = Date.now();
    vi.setSystemTime(t0);
    const id = cache.remember(specs(1));
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
    const a = cache.remember(specs(1));
    const b = cache.remember(specs(1));
    const c = cache.remember(specs(1));
    cache.touch(a); // a is now most-recent
    cache.remember(specs(1)); // forces eviction of LRU head; b should go, not a
    expect(cache.get(a)).toBeDefined();
    expect(cache.get(b)).toBeUndefined();
    expect(cache.get(c)).toBeDefined();
    vi.setSystemTime(t0 + 1001);
    expect(cache.get(a)).toBeUndefined(); // TTL was not refreshed
    vi.useRealTimers();
  });

  it('clear() empties the cache', () => {
    const id = cache.remember(specs(1));
    cache.clear();
    expect(cache.get(id)).toBeUndefined();
  });
});
