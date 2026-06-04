import { describe, it, expect, vi, afterEach } from 'vitest';
import { WallClockGuard } from '../../packages/core/src/bounded-execution/wall-clock-guard.js';

describe('WallClockGuard', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('throws when budget exceeded', () => {
    vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask'] });
    const g = new WallClockGuard(1000);
    vi.advanceTimersByTime(2000);
    expect(() => g.checkOrThrow()).toThrow(/wall-clock/);
  });

  it('throws with guard_wall_clock errorCode', () => {
    vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask'] });
    const g = new WallClockGuard(1000);
    vi.advanceTimersByTime(2000);
    let caught: any;
    try {
      g.checkOrThrow();
    } catch (e) {
      caught = e;
    }
    expect(caught.errorCode).toBe('guard_wall_clock');
    expect(caught.name).toBe('GuardError');
  });

  it('does not throw when budget not exceeded', () => {
    vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask'] });
    const g = new WallClockGuard(1000);
    vi.advanceTimersByTime(500);
    expect(() => g.checkOrThrow()).not.toThrow();
  });

  it('does not throw at exact boundary (budget > elapsed, not >=)', () => {
    vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask'] });
    const g = new WallClockGuard(1000);
    vi.advanceTimersByTime(1000);
    expect(() => g.checkOrThrow()).not.toThrow();
  });

  it('remaining() returns full budget initially', () => {
    vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask'] });
    const g = new WallClockGuard(1000);
    expect(g.remaining()).toBeCloseTo(1000, -1);
  });

  it('remaining() decreases after time advances', () => {
    vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask'] });
    const g = new WallClockGuard(1000);
    vi.advanceTimersByTime(400);
    expect(g.remaining()).toBeCloseTo(600, -1);
  });

  it('remaining() floors at zero', () => {
    vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask'] });
    const g = new WallClockGuard(1000);
    vi.advanceTimersByTime(3000);
    expect(g.remaining()).toBe(0);
  });

  it('rejects negative budgetMs', () => {
    expect(() => new WallClockGuard(-1)).toThrow(/budgetMs/);
  });

  it('rejects NaN budgetMs', () => {
    expect(() => new WallClockGuard(NaN)).toThrow(/budgetMs/);
  });

  it('accepts zero budgetMs', () => {
    expect(() => new WallClockGuard(0)).not.toThrow();
  });
});
