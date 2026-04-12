export function computeNormalizationBudget(maxCostUSD: number | undefined): number {
  const FLAT_CEIL = 0.01;
  if (maxCostUSD === undefined) return FLAT_CEIL;
  if (maxCostUSD <= 0) return 0;
  return Math.min(FLAT_CEIL, 0.2 * maxCostUSD);
}
