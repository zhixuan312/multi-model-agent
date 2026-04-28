import type { RunResult, ReviewVerdict } from '../../types.js';

/**
 * Map RunResult review fields (from executeReviewedLifecycle) into the
 * ExecutorOutput envelope shape. Centralizes the rename + type-narrowing
 * + roundsUsed computation across all 5 read-only executors.
 *
 * Note: specReviewStatus's union is narrower than ReviewVerdict (no 'concerns').
 * For read-only routes (quality_only), specReviewStatus is always
 * 'not_applicable', so the cast is safe in practice.
 */
export function mapReviewVerdicts(
  result: RunResult,
  killSwitchActive: boolean,
): {
  specReviewVerdict: ReviewVerdict;
  qualityReviewVerdict: ReviewVerdict;
  roundsUsed: number;
} {
  if (killSwitchActive) {
    return { specReviewVerdict: 'skipped', qualityReviewVerdict: 'skipped', roundsUsed: 0 };
  }
  return {
    specReviewVerdict: (result.specReviewStatus ?? 'not_applicable') as ReviewVerdict,
    qualityReviewVerdict: (result.qualityReviewStatus ?? 'not_applicable') as ReviewVerdict,
    // CRITICAL: reviewRounds.quality starts at 1 (initial quality review attempt) and
    // increments per rework. So roundsUsed equals reviewRounds.quality directly —
    // do NOT add 1. If reviewRounds is undefined (lifecycle didn't populate it on
    // success path — see Task 3 Step 6), default to 1 (one attempt assumed).
    roundsUsed: result.reviewRounds?.quality ?? 1,
  };
}
