import type { ReviewVerdict } from './reviewer-engine.js';

export interface AggregateInput {
  reviewPolicy: 'full' | 'quality_only' | 'diff_only' | 'none';
  // Final verdict from each chain (last non-skipped row in the chain).
  specChainFinal?:    ReviewVerdict;     // 'approved' | 'concerns' | 'changes_required' | 'error' | 'skipped'
  qualityChainFinal?: ReviewVerdict;     // same enum; 'concerns' is the gating state for quality
  diffFinal?:         ReviewVerdict;
  // For read-only path: AnnotatorEngine output verdict (always 'annotated' or 'error')
  annotatorVerdict?:  'annotated' | 'error';
}

export type OverallReviewVerdict = 'approved' | 'concerns' | 'annotated' | 'not_applicable';

export interface AggregateOutput {
  overallReviewVerdict: OverallReviewVerdict;
  failedChains: Array<'spec' | 'quality' | 'diff'>;   // chains whose final verdict was not 'approved'
}

export class ReviewVerdictAggregator {
  aggregate(input: AggregateInput): AggregateOutput {
    if (input.reviewPolicy === 'none') {
      return { overallReviewVerdict: 'not_applicable', failedChains: [] };
    }
    // Read-only path: annotator output is the only signal.
    if (input.annotatorVerdict) {
      return { overallReviewVerdict: input.annotatorVerdict === 'annotated' ? 'annotated' : 'not_applicable', failedChains: [] };
    }
    const failedChains: Array<'spec' | 'quality' | 'diff'> = [];
    if (input.specChainFinal && input.specChainFinal !== 'approved' && input.specChainFinal !== 'skipped') failedChains.push('spec');
    if (input.qualityChainFinal && input.qualityChainFinal !== 'approved' && input.qualityChainFinal !== 'skipped') failedChains.push('quality');
    if (input.diffFinal && input.diffFinal !== 'approved' && input.diffFinal !== 'skipped') failedChains.push('diff');

    if (failedChains.length === 0) return { overallReviewVerdict: 'approved', failedChains: [] };
    // 'concerns' (any chain ended at concerns/changes_required/error after exhausting attempts)
    return { overallReviewVerdict: 'concerns', failedChains };
  }
}
