import { describe, it, expect } from 'vitest';
import { CostMeter } from '@zhixuan92/multi-model-agent-core/cost/cost-meter';

describe('CostMeter', () => {
  it('starts at zero', () => {
    const m = new CostMeter();
    expect(m.total()).toBe(0);
    expect(m.canProceed(1.0)).toBe(true);
  });

  it('accumulates cost', () => {
    const m = new CostMeter();
    m.add(0.005);
    m.add(0.003);
    expect(m.total()).toBeCloseTo(0.008, 5);
  });

  it('canProceed returns false when ceiling exceeded', () => {
    const m = new CostMeter({ ceiling: 0.01 });
    m.add(0.005);
    expect(m.canProceed(0.005)).toBe(true);
    m.add(0.006);
    expect(m.canProceed(0.005)).toBe(false);
  });

  it('canProceed checks remaining budget for new cost', () => {
    const m = new CostMeter({ ceiling: 0.02 });
    m.add(0.01); // spent $0.01
    expect(m.canProceed(0.015)).toBe(false); // would total $0.025 > $0.02
    expect(m.canProceed(0.005)).toBe(true);  // would total $0.015 < $0.02
  });

  it('ceiling defaults to Infinity when not specified', () => {
    const m = new CostMeter();
    m.add(9999);
    expect(m.canProceed(1.0)).toBe(true);
  });
});
