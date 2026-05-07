import { describe, it, expect } from 'vitest';
import { BatchRegistry } from '@zhixuan92/multi-model-agent-core';

describe('BatchRegistry runningHeadlineSnapshot', () => {
  it('new entry has fallback runningHeadlineSnapshot', () => {
    const reg = new BatchRegistry({ batchTtlMs: 3_600_000 });
    reg.register({
      batchId: 'b1', projectCwd: '/tmp', tool: 'delegate',
      state: 'pending', startedAt: Date.now(), stateChangedAt: Date.now(),
      blockIds: [], blocksReleased: false,
    });
    const snap = reg.get('b1')?.runningHeadlineSnapshot;
    expect(snap).toBeDefined();
    expect(snap!.fallback).toBe('0/1 queued');
  });

  it('updateRunningHeadlineSnapshot sets the field', () => {
    const reg = new BatchRegistry({ batchTtlMs: 3_600_000 });
    reg.register({
      batchId: 'b2', projectCwd: '/tmp', tool: 'delegate',
      state: 'pending', startedAt: 0, stateChangedAt: 0,
      blockIds: [], blocksReleased: false,
    });
    reg.updateRunningHeadlineSnapshot('b2', {
      prefix: '[1/1] Implementing (test) — ',
      statsClause: '',
      dispatchedAt: Date.now(),
      fallback: '1/1 queued',
    });
    const snap = reg.get('b2')?.runningHeadlineSnapshot;
    expect(snap?.prefix).toBe('[1/1] Implementing (test) — ');
  });

  it('updateRunningHeadlineSnapshot is no-op on terminal entries', () => {
    const reg = new BatchRegistry({ batchTtlMs: 3_600_000 });
    reg.register({
      batchId: 'b3', projectCwd: '/tmp', tool: 'delegate',
      state: 'complete', startedAt: 0, stateChangedAt: 0,
      blockIds: [], blocksReleased: true,
    });
    reg.updateRunningHeadlineSnapshot('b3', {
      prefix: 'should be ignored',
      statsClause: '',
      dispatchedAt: 0,
      fallback: '',
    });
    const snap = reg.get('b3')?.runningHeadlineSnapshot;
    expect(snap?.prefix).toBe('');
  });

  it('updateRunningHeadlineSnapshot is no-op on unknown batchId', () => {
    const reg = new BatchRegistry({ batchTtlMs: 3_600_000 });
    expect(() => reg.updateRunningHeadlineSnapshot('unknown', {
      prefix: 'x', statsClause: '', dispatchedAt: 0, fallback: '',
    })).not.toThrow();
  });
});
