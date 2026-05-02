import { MAX_TIME_PRESTOP_RATIO } from '../../config/schema.js';

/**
 * Check if the wall clock has reached the time ceiling threshold.
 * Uses `!= null` (not truthy) so timeoutMs=0 IS handled — a silly
 * but valid input should not be silently skipped.
 *
 * Returns the wallClockMs if ceiling is tripped, otherwise null.
 */
export function checkTimeCeiling(
  taskStartMs: number,
  timeoutMs: number | undefined,
): number | null {
  if (timeoutMs != null) {
    const wallClockMs = Date.now() - taskStartMs;
    if (wallClockMs >= MAX_TIME_PRESTOP_RATIO * timeoutMs) {
      return wallClockMs;
    }
  }
  return null;
}
