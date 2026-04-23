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
