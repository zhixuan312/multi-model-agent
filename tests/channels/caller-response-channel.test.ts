import { describe, it, expect } from 'vitest';
import { CallerResponseChannel } from '../../packages/core/src/channels/caller-response-channel.js';

describe('CallerResponseChannel', () => {
  it('snapshots in taskIndex order', () => {
    const c = new CallerResponseChannel();
    c.upsert({ taskIndex: 1, workerStatus: 'done' });
    c.upsert({ taskIndex: 0, workerStatus: 'done' });
    expect(c.snapshot().map(e => e.taskIndex)).toEqual([0, 1]);
  });

  it('upsert overwrites by taskIndex', () => {
    const c = new CallerResponseChannel();
    c.upsert({ taskIndex: 0, workerStatus: 'done', summary: 'first' });
    c.upsert({ taskIndex: 0, workerStatus: 'failed', summary: 'second' });
    const snap = c.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].workerStatus).toBe('failed');
    expect(snap[0].summary).toBe('second');
  });

  it('snapshot returns empty array for no entries', () => {
    const c = new CallerResponseChannel();
    expect(c.snapshot()).toEqual([]);
  });
});
