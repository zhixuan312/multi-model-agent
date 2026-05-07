import { describe, it, expect } from 'vitest';
import { LifecycleDriver } from '../../packages/core/src/lifecycle/lifecycle-driver.js';

describe('LifecycleDriver', () => {
  it('runs rows in order until terminal', async () => {
    const calls: string[] = [];
    const driver = new LifecycleDriver(
      {
        toolCategory: 'read_only',
        rows: [
          { rowId: 'a', stageName: 'a', runCondition: () => true, isRework: false, handlerKey: 'a' },
          { rowId: 'b', stageName: 'b', runCondition: () => true, isRework: false, handlerKey: 'b' },
          { rowId: 'c', stageName: 'c', runCondition: () => true, isRework: false, handlerKey: 'c' },
        ],
      },
      {
        a: (s) => { calls.push('a'); },
        b: (s) => { calls.push('b'); s.terminal = true; },
        c: (s) => { calls.push('c'); },
      },
    );
    await driver.run({ terminal: false, attemptIndex: 0, attemptBudget: 1, reviewPolicy: 'none', shutdownInProgress: false });
    expect(calls).toEqual(['a', 'b']);   // c skipped because terminal
  });

  it('skips rows whose runCondition is false', async () => {
    const calls: string[] = [];
    const driver = new LifecycleDriver(
      {
        toolCategory: 'read_only',
        rows: [
          { rowId: 'a', stageName: 'a', runCondition: () => false, isRework: false, handlerKey: 'a' },
          { rowId: 'b', stageName: 'b', runCondition: () => true, isRework: false, handlerKey: 'b' },
        ],
      },
      { a: () => { calls.push('a'); }, b: () => { calls.push('b'); } },
    );
    await driver.run({ terminal: false, attemptIndex: 0, attemptBudget: 1, reviewPolicy: 'none', shutdownInProgress: false });
    expect(calls).toEqual(['b']);
  });

  it('throws when handler missing', async () => {
    const driver = new LifecycleDriver(
      { toolCategory: 'read_only', rows: [{ rowId: 'x', stageName: 'x', runCondition: () => true, isRework: false, handlerKey: 'missing' }] },
      {},
    );
    await expect(driver.run({ terminal: false, attemptIndex: 0, attemptBudget: 1, reviewPolicy: 'none', shutdownInProgress: false })).rejects.toThrow(/no handler registered/);
  });
});
