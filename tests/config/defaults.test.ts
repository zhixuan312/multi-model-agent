import {
  DEFAULT_TASK_TIMEOUT_MS,
  DEFAULT_STALL_TIMEOUT_MS,
  MAX_TIME_PRESTOP_RATIO,
  multiModelConfigSchema,
} from '../../packages/core/src/config/schema.js';

// ---------------------------------------------------------------------------
// Export stability
// ---------------------------------------------------------------------------
describe('budget defaults are exported and stable', () => {
  it('DEFAULT_TASK_TIMEOUT_MS = 1 hour', () => {
    expect(DEFAULT_TASK_TIMEOUT_MS).toBe(3_600_000);
  });

  it('DEFAULT_STALL_TIMEOUT_MS = 20 min', () => {
    expect(DEFAULT_STALL_TIMEOUT_MS).toBe(1_200_000);
  });

  it('MAX_TIME_PRESTOP_RATIO = 0.80', () => {
    expect(MAX_TIME_PRESTOP_RATIO).toBe(0.80);
  });

  it('DEFAULT_TASK_TIMEOUT_MS is greater than DEFAULT_STALL_TIMEOUT_MS', () => {
    expect(DEFAULT_TASK_TIMEOUT_MS).toBeGreaterThan(DEFAULT_STALL_TIMEOUT_MS);
  });

  it('prestop ratios are between 0 and 1', () => {
    expect(MAX_TIME_PRESTOP_RATIO).toBeGreaterThan(0);
    expect(MAX_TIME_PRESTOP_RATIO).toBeLessThan(1);
  });
});
