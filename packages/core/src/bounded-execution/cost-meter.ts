import type { TokenUsage } from '../runners/types.js';

export interface Pricing {
  inputUSDPerMillion: number;
  outputUSDPerMillion: number;
  cachedReadUSDPerMillion: number;
  cachedNonReadUSDPerMillion: number;
}

export class CostMeter {
  private accumulated = { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 };

  accumulate(usage: TokenUsage): void {
    this.accumulated.inputTokens += usage.inputTokens;
    this.accumulated.outputTokens += usage.outputTokens;
    this.accumulated.cachedReadTokens += usage.cachedReadTokens;
    this.accumulated.cachedNonReadTokens += usage.cachedNonReadTokens;
  }

  calculate(pricing: Pricing): { actualCostUSD: number } {
    const a = this.accumulated;
    const cost =
      (a.inputTokens / 1e6) * pricing.inputUSDPerMillion +
      (a.outputTokens / 1e6) * pricing.outputUSDPerMillion +
      (a.cachedReadTokens / 1e6) * pricing.cachedReadUSDPerMillion +
      (a.cachedNonReadTokens / 1e6) * pricing.cachedNonReadUSDPerMillion;
    return { actualCostUSD: cost };
  }

  delta(prior: { actualCostUSD: number }, current: { actualCostUSD: number }): number {
    return current.actualCostUSD - prior.actualCostUSD;
  }
}
