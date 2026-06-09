import { describe, it, expect } from 'vitest';
import {
  withWriteGoalLock,
  WriteGoalBusyError,
  __writeGoalLockMapSizeForTest,
} from '../../packages/core/src/lifecycle/write-goal-lock.js';

describe('withWriteGoalLock', () => {
  it('serializes same-key goal-sets (FIFO), runs distinct keys concurrently (AC-19)', async () => {
    const order: string[] = [];
    const slow = (label: string, ms: number) => async () => {
      order.push(`${label}:start`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`${label}:end`);
    };
    // Two on the same repo key serialize; a third on a different key overlaps.
    const a = withWriteGoalLock('/repo1', slow('a', 30));
    const b = withWriteGoalLock('/repo1', slow('b', 5));
    const c = withWriteGoalLock('/repo2', slow('c', 5));
    await Promise.all([a, b, c]);
    // a fully completes before b starts (same key, FIFO).
    expect(order.indexOf('a:end')).toBeLessThan(order.indexOf('b:start'));
    // c (distinct key) starts before a ends (concurrent).
    expect(order.indexOf('c:start')).toBeLessThan(order.indexOf('a:end'));
  });

  it('rejects with WriteGoalBusyError when acquisition exceeds the timeout (AC-16)', async () => {
    let releaseHolder!: () => void;
    const holder = withWriteGoalLock('/busy', () => new Promise<void>((r) => { releaseHolder = r; }));
    // Second caller waits behind the holder; force a tiny timeout.
    await expect(
      withWriteGoalLock('/busy', async () => { /* never reached */ }, 20),
    ).rejects.toBeInstanceOf(WriteGoalBusyError);
    releaseHolder();
    await holder;
  });

  it('drops idle keys so the map stays bounded', async () => {
    await withWriteGoalLock('/transient', async () => { /* no-op */ });
    expect(__writeGoalLockMapSizeForTest()).toBe(0);
  });
});
