import { describe, it, expect, vi } from 'vitest';
import { WallClockGuard } from '../../packages/core/src/bounded-execution/wall-clock-guard.js';

describe('WallClockGuard', () => {
  it('throws when budget exceeded', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask'] });
    const g = new WallClockGuard(1000);
    vi.advanceTimersByTime(2000);
    expect(() => g.checkOrThrow()).toThrow(/wall-clock/);
    vi.useRealTimers();
  });
});
