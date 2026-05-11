import { describe, it, expect } from 'vitest';
import { WallClockGuard } from '../../packages/core/src/bounded-execution/wall-clock-guard.js';

describe('WallClockGuard end-to-end enforcement', () => {
  it('checkOrThrow throws GuardError after budget exceeded', async () => {
    const guard = new WallClockGuard(50);
    expect(() => guard.checkOrThrow()).not.toThrow();
    await new Promise(r => setTimeout(r, 80));
    expect(() => guard.checkOrThrow()).toThrowError(/wall-clock budget exceeded/);
  });

  it('error has errorCode guard_wall_clock', async () => {
    const guard = new WallClockGuard(20);
    await new Promise(r => setTimeout(r, 50));
    try {
      guard.checkOrThrow();
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as { errorCode: string }).errorCode).toBe('guard_wall_clock');
    }
  });

  it('remaining decreases over time and clamps to 0', async () => {
    const guard = new WallClockGuard(100);
    const r1 = guard.remaining();
    expect(r1).toBeGreaterThan(0);
    await new Promise(r => setTimeout(r, 130));
    expect(guard.remaining()).toBe(0);
  });
});
