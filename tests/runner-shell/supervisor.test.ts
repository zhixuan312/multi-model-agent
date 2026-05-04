import { describe, it, expect, vi } from 'vitest';
import { Supervisor } from '../../packages/core/src/runner-shell/supervisor.js';

describe('Supervisor', () => {
  it('detects stall after threshold', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'setImmediate', 'Date'] });
    const s = new Supervisor();
    s.observe();
    vi.advanceTimersByTime(10_000);
    expect(s.isStalled(5_000)).toBe(true);
    vi.useRealTimers();
  });

  it('reports not stalled before threshold', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'setImmediate', 'Date'] });
    const s = new Supervisor();
    s.observe();
    vi.advanceTimersByTime(3_000);
    expect(s.isStalled(5_000)).toBe(false);
    vi.useRealTimers();
  });

  it('tracks stall count', () => {
    const s = new Supervisor();
    expect(s.getStallCount()).toBe(0);
    s.incStall();
    expect(s.getStallCount()).toBe(1);
    s.incStall();
    expect(s.getStallCount()).toBe(2);
  });

  it('observe resets the stall window', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'setImmediate', 'Date'] });
    const s = new Supervisor();
    s.observe();
    vi.advanceTimersByTime(4_000);
    s.observe();
    vi.advanceTimersByTime(4_000);
    expect(s.isStalled(5_000)).toBe(false);
    vi.useRealTimers();
  });
});
