import {
  DEFAULT_TASK_TIMEOUT_MS,
  DEFAULT_STALL_TIMEOUT_MS,
  DEFAULT_MAX_COST_USD,
  MAX_COST_PRESTOP_RATIO,
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

  it('DEFAULT_MAX_COST_USD = $10', () => {
    expect(DEFAULT_MAX_COST_USD).toBe(10);
  });

  it('MAX_COST_PRESTOP_RATIO = 0.80', () => {
    expect(MAX_COST_PRESTOP_RATIO).toBe(0.80);
  });

  it('MAX_TIME_PRESTOP_RATIO = 0.80', () => {
    expect(MAX_TIME_PRESTOP_RATIO).toBe(0.80);
  });

  it('prestop ratios are symmetric', () => {
    expect(MAX_COST_PRESTOP_RATIO).toBe(MAX_TIME_PRESTOP_RATIO);
  });

  it('DEFAULT_TASK_TIMEOUT_MS is greater than DEFAULT_STALL_TIMEOUT_MS', () => {
    expect(DEFAULT_TASK_TIMEOUT_MS).toBeGreaterThan(DEFAULT_STALL_TIMEOUT_MS);
  });

  it('prestop ratios are between 0 and 1', () => {
    expect(MAX_COST_PRESTOP_RATIO).toBeGreaterThan(0);
    expect(MAX_COST_PRESTOP_RATIO).toBeLessThan(1);
    expect(MAX_TIME_PRESTOP_RATIO).toBeGreaterThan(0);
    expect(MAX_TIME_PRESTOP_RATIO).toBeLessThan(1);
  });

  it('worst-case total = DEFAULT / PRESTOP_RATIO', () => {
    const worstCaseCost = DEFAULT_MAX_COST_USD / MAX_COST_PRESTOP_RATIO;
    const worstCaseTime = DEFAULT_TASK_TIMEOUT_MS / MAX_TIME_PRESTOP_RATIO;
    expect(worstCaseCost).toBe(12.5);
    expect(worstCaseTime).toBe(4_500_000);
  });
});

// ---------------------------------------------------------------------------
// Schema behavior — maxCostUSD parsing
// ---------------------------------------------------------------------------
describe('multiModelConfigSchema maxCostUSD behavior', () => {
  const baseConfig = {
    agents: {
      standard: { type: 'claude' as const, model: 'haiku' },
      complex: { type: 'claude' as const, model: 'sonnet' },
    },
  };

  it('omitted maxCostUSD parses to DEFAULT_MAX_COST_USD', () => {
    const parsed = multiModelConfigSchema.parse(baseConfig);
    expect(parsed.defaults.maxCostUSD).toBe(DEFAULT_MAX_COST_USD);
  });

  it('omitted timeoutMs parses to DEFAULT_TASK_TIMEOUT_MS', () => {
    const parsed = multiModelConfigSchema.parse(baseConfig);
    expect(parsed.defaults.timeoutMs).toBe(DEFAULT_TASK_TIMEOUT_MS);
  });

  it('omitted stallTimeoutMs parses to DEFAULT_STALL_TIMEOUT_MS', () => {
    const parsed = multiModelConfigSchema.parse(baseConfig);
    expect(parsed.defaults.stallTimeoutMs).toBe(DEFAULT_STALL_TIMEOUT_MS);
  });

  it('explicit maxCostUSD override is preserved', () => {
    const parsed = multiModelConfigSchema.parse({
      ...baseConfig,
      defaults: { maxCostUSD: 25 },
    });
    expect(parsed.defaults.maxCostUSD).toBe(25);
  });

  it('maxCostUSD = 0 is accepted (free-agent runs)', () => {
    const parsed = multiModelConfigSchema.parse({
      ...baseConfig,
      defaults: { maxCostUSD: 0 },
    });
    expect(parsed.defaults.maxCostUSD).toBe(0);
  });

  it('negative maxCostUSD is rejected', () => {
    expect(() =>
      multiModelConfigSchema.parse({
        ...baseConfig,
        defaults: { maxCostUSD: -5 },
      }),
    ).toThrow();
  });

  it('NaN maxCostUSD is rejected', () => {
    expect(() =>
      multiModelConfigSchema.parse({
        ...baseConfig,
        defaults: { maxCostUSD: NaN },
      }),
    ).toThrow();
  });

  it('Infinity maxCostUSD is rejected', () => {
    expect(() =>
      multiModelConfigSchema.parse({
        ...baseConfig,
        defaults: { maxCostUSD: Infinity },
      }),
    ).toThrow();
  });

  it('negative timeoutMs is rejected', () => {
    expect(() =>
      multiModelConfigSchema.parse({
        ...baseConfig,
        defaults: { timeoutMs: -1 },
      }),
    ).toThrow();
  });

  it('zero timeoutMs is rejected (must be positive)', () => {
    expect(() =>
      multiModelConfigSchema.parse({
        ...baseConfig,
        defaults: { timeoutMs: 0 },
      }),
    ).toThrow();
  });
});
