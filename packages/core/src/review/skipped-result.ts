export interface SkippedReviewResult {
  status: 'skipped';
  report: undefined;
  findings: string[];
  reason: 'all_tiers_unavailable';
}

export function makeSkippedReviewResult(
  reason: 'all_tiers_unavailable',
): SkippedReviewResult {
  return { status: 'skipped', report: undefined, findings: [], reason };
}
