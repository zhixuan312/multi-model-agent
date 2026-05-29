import { describe, it, expect } from 'bun:test';
import { GuardError, WallClockGuard } from '../../packages/core/src/bounded-execution/wall-clock-guard.js';

describe('WallClockGuard error code', () => {
  it('throws GuardError with errorCode "guard_wall_clock" past the budget', () => {
    const guard = new WallClockGuard(1); // 1ms budget
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin past budget */ }
    expect(() => guard.checkOrThrow()).toThrow(GuardError);
    try {
      guard.checkOrThrow();
    } catch (err) {
      expect((err as GuardError).errorCode).toBe('guard_wall_clock');
    }
  });
});
