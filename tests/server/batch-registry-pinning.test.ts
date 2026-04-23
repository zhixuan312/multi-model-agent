import { describe, it, expect, vi } from 'vitest';
import { BatchRegistry } from '../../packages/core/src/batch-registry.js';
import { InMemoryContextBlockStore } from '../../packages/core/src/context/context-block-store.js';
import type { BatchEntry } from '../../packages/core/src/batch-registry.js';

function makeEntry(batchId: string, blockIds: string[], overrides: Partial<BatchEntry> = {}): BatchEntry {
  return {
    batchId,
    projectCwd: '/x',
    tool: 'delegate',
    state: 'pending',
    startedAt: 0,
    stateChangedAt: 0,
    blockIds,
    blocksReleased: false,
    ...overrides,
  };
}

describe('BatchRegistry context-block refcount pinning', () => {
  it('on register with blockIds: refcount is incremented; on first terminal transition: decremented exactly once', () => {
    const blocks = new InMemoryContextBlockStore();
    const { id: bid } = blocks.register('content');
    const reg = new BatchRegistry({}, { contextBlockStore: blocks });
    reg.register(makeEntry('b8', [bid]));
    expect(blocks.refcount(bid)).toBe(1);
    reg.complete('b8', {});
    expect(blocks.refcount(bid)).toBe(0);
  });

  it('second terminal transition (expiry sweep) must not decrement again', () => {
    vi.useFakeTimers();
    const blocks = new InMemoryContextBlockStore();
    const { id: bid } = blocks.register('content');
    const reg = new BatchRegistry({ batchTtlMs: 1000, clarificationTimeoutMs: 60_000 }, { contextBlockStore: blocks });
    reg.register(makeEntry('b8b', [bid]));
    expect(blocks.refcount(bid)).toBe(1);
    reg.complete('b8b', {});
    expect(blocks.refcount(bid)).toBe(0);
    // Advance time and run expiry sweep — should not go negative
    vi.setSystemTime(Date.now() + 2000);
    reg.runExpirySweep();
    expect(reg.get('b8b')?.state).toBe('expired');
    expect(blocks.refcount(bid)).toBe(0); // still 0, not -1
    vi.useRealTimers();
  });

  it('fail() releases blocks exactly once', () => {
    const blocks = new InMemoryContextBlockStore();
    const { id: bid } = blocks.register('content');
    const reg = new BatchRegistry({}, { contextBlockStore: blocks });
    reg.register(makeEntry('b9', [bid]));
    expect(blocks.refcount(bid)).toBe(1);
    reg.fail('b9', { code: 'E', message: 'boom' });
    expect(blocks.refcount(bid)).toBe(0);
    // second fail is no-op — refcount stays 0
    reg.fail('b9', { code: 'E', message: 'second' });
    expect(blocks.refcount(bid)).toBe(0);
  });

  it('clarification timeout sweep releases blocks', () => {
    vi.useFakeTimers();
    const blocks = new InMemoryContextBlockStore();
    const { id: bid } = blocks.register('content');
    const reg = new BatchRegistry({ clarificationTimeoutMs: 1000 }, { contextBlockStore: blocks });
    reg.register(makeEntry('b10', [bid], { state: 'awaiting_clarification', stateChangedAt: Date.now() }));
    expect(blocks.refcount(bid)).toBe(1);
    vi.advanceTimersByTime(2000);
    reg.runClarificationTimeoutSweep();
    expect(reg.get('b10')?.state).toBe('failed');
    expect(blocks.refcount(bid)).toBe(0);
    vi.useRealTimers();
  });

  it('register with no blockIds — no pin/unpin calls (no error)', () => {
    const blocks = new InMemoryContextBlockStore();
    const reg = new BatchRegistry({}, { contextBlockStore: blocks });
    reg.register(makeEntry('b11', []));
    reg.complete('b11', {});
    expect(reg.get('b11')?.state).toBe('complete');
    expect(reg.get('b11')?.blocksReleased).toBe(true);
  });

  it('pinned entries are not evicted by LRU', () => {
    const blocks = new InMemoryContextBlockStore({ maxEntries: 2 });
    const { id: bid1 } = blocks.register('block 1');
    const { id: bid2 } = blocks.register('block 2');
    // pin block 1
    blocks.pin(bid1);
    expect(blocks.refcount(bid1)).toBe(1);
    // Adding a third block should evict block 2 (the oldest unpinned), not block 1
    blocks.register('block 3');
    expect(blocks.get(bid1)).toBe('block 1'); // pinned — survives
    expect(blocks.get(bid2)).toBeUndefined(); // evicted
    blocks.unpin(bid1);
    expect(blocks.refcount(bid1)).toBe(0);
  });

  it('countActiveForProject counts only non-terminal entries for the given cwd', () => {
    const reg = new BatchRegistry();
    reg.register(makeEntry('ba', [], { projectCwd: '/proj' }));
    reg.register(makeEntry('bb', [], { projectCwd: '/proj' }));
    reg.register(makeEntry('bc', [], { projectCwd: '/other' }));
    expect(reg.countActiveForProject('/proj')).toBe(2);
    reg.complete('ba', {});
    expect(reg.countActiveForProject('/proj')).toBe(1);
    reg.complete('bb', {});
    expect(reg.countActiveForProject('/proj')).toBe(0);
    expect(reg.countActiveForProject('/other')).toBe(1);
  });
});
