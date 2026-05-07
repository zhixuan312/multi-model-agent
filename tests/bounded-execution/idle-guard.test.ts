import { describe, it, expect, vi } from 'vitest';
import { IdleGuard } from '../../packages/core/src/bounded-execution/idle-guard.js';

describe('IdleGuard', () => {
  const FAKE = ['Date', 'setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask'] as const;

  it('throws when idle exceeded', () => {
    vi.useFakeTimers({ toFake: [...FAKE] });
    const g = new IdleGuard(1000);
    vi.advanceTimersByTime(2000);
    expect(() => g.checkOrThrow()).toThrow(/idle/);
    vi.useRealTimers();
  });

  it('resets on model signal', () => {
    vi.useFakeTimers({ toFake: [...FAKE] });
    const g = new IdleGuard(1000);
    vi.advanceTimersByTime(800);
    g.resetOnModelSignal();
    vi.advanceTimersByTime(800);
    expect(() => g.checkOrThrow()).not.toThrow();
    vi.useRealTimers();
  });
});
