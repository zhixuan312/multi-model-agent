import { describe, it, expect } from 'vitest';
import { BatchRegistry } from '@zhixuan92/multi-model-agent-core';

describe('BatchRegistry runningHeadline', () => {
  it('new entry has empty runningHeadline', () => {
    const reg = new BatchRegistry({ clarificationTimeoutMs: 60_000, batchTtlMs: 3_600_000 });
    reg.register({
      batchId: 'b1', projectCwd: '/tmp', tool: 'delegate',
      state: 'pending', startedAt: Date.now(), stateChangedAt: Date.now(),
      blockIds: [], blocksReleased: false,
    });
    expect(reg.get('b1')?.runningHeadline).toBe('');
  });

  it('updateRunningHeadline sets the field', () => {
    const reg = new BatchRegistry({ clarificationTimeoutMs: 60_000, batchTtlMs: 3_600_000 });
    reg.register({
      batchId: 'b2', projectCwd: '/tmp', tool: 'delegate',
      state: 'pending', startedAt: 0, stateChangedAt: 0,
      blockIds: [], blocksReleased: false,
    });
    reg.updateRunningHeadline('b2', '1/1 running, 47s elapsed');
    expect(reg.get('b2')?.runningHeadline).toBe('1/1 running, 47s elapsed');
  });

  it('updateRunningHeadline is no-op on terminal entries', () => {
    const reg = new BatchRegistry({ clarificationTimeoutMs: 60_000, batchTtlMs: 3_600_000 });
    reg.register({
      batchId: 'b3', projectCwd: '/tmp', tool: 'delegate',
      state: 'complete', startedAt: 0, stateChangedAt: 0,
      blockIds: [], blocksReleased: true,
    });
    reg.updateRunningHeadline('b3', 'should be ignored');
    expect(reg.get('b3')?.runningHeadline).toBe('');
  });

  it('updateRunningHeadline is no-op on unknown batchId', () => {
    const reg = new BatchRegistry({ clarificationTimeoutMs: 60_000, batchTtlMs: 3_600_000 });
    expect(() => reg.updateRunningHeadline('unknown', 'x')).not.toThrow();
  });
});
