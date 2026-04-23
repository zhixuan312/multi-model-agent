import { describe, it, expect, vi } from 'vitest';
import { BatchRegistry, BatchState, isTerminal, InvalidBatchStateError } from '../../packages/core/src/batch-registry.js';
import type { BatchEntry } from '../../packages/core/src/batch-registry.js';

function makeEntry(batchId: string, overrides: Partial<BatchEntry> = {}): BatchEntry {
  return {
    batchId,
    projectCwd: '/x',
    tool: 'delegate',
    state: 'pending',
    startedAt: 0,
    stateChangedAt: 0,
    blockIds: [],
    blocksReleased: false,
    ...overrides,
  };
}

describe('batch state machine', () => {
  it('defines exactly the five states', () => {
    const states: BatchState[] = ['pending', 'awaiting_clarification', 'complete', 'failed', 'expired'];
    // Type-level assertion; also runtime sanity:
    expect(states.length).toBe(5);
  });

  it('classifies terminal vs non-terminal', () => {
    expect(isTerminal('pending')).toBe(false);
    expect(isTerminal('awaiting_clarification')).toBe(false);
    expect(isTerminal('complete')).toBe(true);
    expect(isTerminal('failed')).toBe(true);
    expect(isTerminal('expired')).toBe(true);
  });
});

describe('complete() / fail() idempotency', () => {
  it('complete() is idempotent on already-terminal entries', () => {
    const reg = new BatchRegistry();
    reg.register(makeEntry('b1'));
    reg.complete('b1', { ok: true });
    reg.complete('b1', { ok: 'second call ignored' }); // should be no-op
    expect(reg.get('b1')?.result).toEqual({ ok: true });
  });

  it('fail() is idempotent', () => {
    const reg = new BatchRegistry();
    reg.register(makeEntry('b2', { tool: 'audit' }));
    reg.fail('b2', { code: 'E', message: 'first' });
    reg.fail('b2', { code: 'E', message: 'second' }); // no-op
    expect(reg.get('b2')?.error?.message).toBe('first');
  });

  it('complete() does not overwrite a failed batch', () => {
    const reg = new BatchRegistry();
    reg.register(makeEntry('b3', { tool: 'audit' }));
    reg.fail('b3', { code: 'X', message: 'boom' });
    reg.complete('b3', { shouldNotApply: true }); // no-op
    expect(reg.get('b3')?.state).toBe('failed');
  });
});

describe('clarification transitions', () => {
  it('pending → awaiting_clarification → pending → complete (with interpretation delivery)', async () => {
    const reg = new BatchRegistry();
    const entry = makeEntry('b4');
    reg.register(entry);
    // executor awaits:
    const received = new Promise<string>((resolve) => { entry.resolveClarification = resolve; });
    reg.requestClarification('b4', 'did you mean X?');
    expect(reg.get('b4')?.state).toBe('awaiting_clarification');
    expect(reg.get('b4')?.proposedInterpretation).toBe('did you mean X?');
    // client confirms:
    reg.resumeFromClarification('b4', 'yes, X is right');
    expect(reg.get('b4')?.state).toBe('pending');
    expect(await received).toBe('yes, X is right');
    reg.complete('b4', {});
    expect(reg.get('b4')?.state).toBe('complete');
  });

  it('resumeFromClarification on wrong state throws InvalidBatchStateError', () => {
    const reg = new BatchRegistry();
    reg.register(makeEntry('b5'));
    expect(() => reg.resumeFromClarification('b5', 'anything')).toThrow(InvalidBatchStateError);
    expect(() => reg.resumeFromClarification('b5', 'anything')).toThrow(/invalid_batch_state/);
  });

  it('idempotent double-confirm with same interpretation is a no-op', () => {
    const reg = new BatchRegistry();
    const entry = makeEntry('b5b');
    entry.resolveClarification = () => {};
    reg.register(entry);
    reg.requestClarification('b5b', 'did you mean X?');
    reg.resumeFromClarification('b5b', 'yes X');
    // second call with same interpretation must not throw:
    expect(() => reg.resumeFromClarification('b5b', 'yes X')).not.toThrow();
  });

  it('double-confirm with different interpretation throws InvalidBatchStateError', () => {
    const reg = new BatchRegistry();
    const entry = makeEntry('b5c');
    entry.resolveClarification = () => {};
    reg.register(entry);
    reg.requestClarification('b5c', 'did you mean X?');
    reg.resumeFromClarification('b5c', 'yes A');
    // second call with DIFFERENT interpretation must throw:
    expect(() => reg.resumeFromClarification('b5c', 'no, B')).toThrow(InvalidBatchStateError);
  });

  it('clarification timeout sweeper transitions to failed with clarification_abandoned', () => {
    vi.useFakeTimers();
    const reg = new BatchRegistry({ clarificationTimeoutMs: 1000 });
    reg.register(makeEntry('b6', { state: 'awaiting_clarification', stateChangedAt: Date.now() }));
    vi.advanceTimersByTime(2000);
    reg.runClarificationTimeoutSweep();
    expect(reg.get('b6')?.state).toBe('failed');
    expect(reg.get('b6')?.error?.code).toBe('clarification_abandoned');
    vi.useRealTimers();
  });
});

describe('TTL expiry sweep', () => {
  it('complete batches transition to expired after batchTtlMs', () => {
    vi.useFakeTimers();
    const reg = new BatchRegistry({ batchTtlMs: 1000, clarificationTimeoutMs: 60_000 });
    reg.register(makeEntry('b7'));
    reg.complete('b7', {});
    vi.setSystemTime(Date.now() + 2000);
    reg.runExpirySweep();
    expect(reg.get('b7')?.state).toBe('expired');
    vi.useRealTimers();
  });

  it('failed batches also transition to expired after batchTtlMs', () => {
    vi.useFakeTimers();
    const reg = new BatchRegistry({ batchTtlMs: 1000, clarificationTimeoutMs: 60_000 });
    reg.register(makeEntry('b7a'));
    reg.fail('b7a', { code: 'E', message: 'boom' });
    vi.setSystemTime(Date.now() + 2000);
    reg.runExpirySweep();
    expect(reg.get('b7a')?.state).toBe('expired');
    vi.useRealTimers();
  });

  it('expired batches are deleted on the next sweep cycle', () => {
    const reg = new BatchRegistry({ batchTtlMs: 1000, clarificationTimeoutMs: 60_000 });
    // set up an already-expired entry
    reg.register(makeEntry('b7b', { state: 'expired', stateChangedAt: Date.now() - 10_000 }));
    reg.runExpirySweep();
    expect(reg.get('b7b')).toBeUndefined();
  });

  it('expired state never re-transitions via complete()', () => {
    const reg = new BatchRegistry({ batchTtlMs: 1000, clarificationTimeoutMs: 60_000 });
    reg.register(makeEntry('b7c', { state: 'expired' }));
    reg.complete('b7c', {}); // no-op per idempotency
    expect(reg.get('b7c')?.state).toBe('expired');
  });
});
