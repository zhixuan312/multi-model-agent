import { describe, it, expect } from 'bun:test';
import { withProjectJournalLock, __journalLockMapSize } from '../../packages/server/src/http/journal-lock.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('withProjectJournalLock', () => {
  it('serializes calls on the same cwd (AC-5 mechanism)', async () => {
    const order: string[] = [];
    const a = withProjectJournalLock('/p', async () => { order.push('a-start'); await sleep(30); order.push('a-end'); });
    const b = withProjectJournalLock('/p', async () => { order.push('b-start'); await sleep(5); order.push('b-end'); });
    await Promise.all([a, b]);
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
  });
  it('runs concurrently on different cwds', async () => {
    const order: string[] = [];
    const a = withProjectJournalLock('/p1', async () => { order.push('a-start'); await sleep(30); order.push('a-end'); });
    const b = withProjectJournalLock('/p2', async () => { order.push('b-start'); await sleep(5); order.push('b-end'); });
    await Promise.all([a, b]);
    expect(order).toEqual(['a-start', 'b-start', 'b-end', 'a-end']);
  });
  it('releases the lock even when fn throws (AC-12)', async () => {
    await expect(withProjectJournalLock('/p', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    let ran = false;
    await withProjectJournalLock('/p', async () => { ran = true; });
    expect(ran).toBe(true);
  });
  it('removes the cwd map entry after the last caller completes (AC-14)', async () => {
    await withProjectJournalLock('/solo', async () => { await sleep(1); });
    expect(__journalLockMapSize()).toBe(0);
  });
  it('returns the fn result', async () => {
    expect(await withProjectJournalLock('/p', async () => 42)).toBe(42);
  });
});
