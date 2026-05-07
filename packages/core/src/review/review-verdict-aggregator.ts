import type { ReviewVerdict } from '../types.js';

export interface ReviewSlot {
  verdict: ReviewVerdict;
  concerns?: string[];
}

export interface AggregatedReviews {
  finalVerdict: ReviewVerdict;
  allConcerns: string[];
}

const VERDICT_PRIORITY: Record<ReviewVerdict, number> = {
  error: 5,
  changes_required: 4,
  concerns: 3,
  annotated: 2,
  approved: 1,
  not_applicable: 0,
  skipped: 0,
};

/**
 * Aggregate verdicts across multiple review slots (spec/quality/diff).
 * The final verdict is the most-severe across slots; concerns are unioned.
 *
 * Severity order: error > changes_required > concerns > annotated > approved > not_applicable/skipped.
 */
export function aggregateReviews(slots: ReviewSlot[]): AggregatedReviews {
  let finalVerdict: ReviewVerdict = 'not_applicable';
  const allConcerns: string[] = [];
  for (const slot of slots) {
    if ((VERDICT_PRIORITY[slot.verdict] ?? 0) > (VERDICT_PRIORITY[finalVerdict] ?? 0)) {
      finalVerdict = slot.verdict;
    }
    if (slot.concerns) {
      for (const c of slot.concerns) allConcerns.push(c);
    }
  }
  return { finalVerdict, allConcerns };
}
