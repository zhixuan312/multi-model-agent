import { describe, it, expect } from 'vitest';
import { ReviewVerdictAggregator } from '../../packages/core/src/engines/review-verdict-aggregator.js';

describe('ReviewVerdictAggregator', () => {
  const a = new ReviewVerdictAggregator();
  it('reviewPolicy=none -> not_applicable', () => {
    expect(a.aggregate({ reviewPolicy: 'none' })).toEqual({ overallReviewVerdict: 'not_applicable', failedChains: [] });
  });
  it('all chains approved -> approved', () => {
    const r = a.aggregate({ reviewPolicy: 'full', specChainFinal: 'approved', qualityChainFinal: 'approved', diffFinal: 'approved' });
    expect(r.overallReviewVerdict).toBe('approved');
    expect(r.failedChains).toEqual([]);
  });
  it('quality chain ends at concerns -> overall=concerns; failedChains=[quality]', () => {
    const r = a.aggregate({ reviewPolicy: 'full', specChainFinal: 'approved', qualityChainFinal: 'concerns', diffFinal: 'approved' });
    expect(r.overallReviewVerdict).toBe('concerns');
    expect(r.failedChains).toEqual(['quality']);
  });
  it('spec chain changes_required + quality concerns -> failedChains lists both', () => {
    const r = a.aggregate({ reviewPolicy: 'full', specChainFinal: 'changes_required', qualityChainFinal: 'concerns', diffFinal: 'approved' });
    expect(r.failedChains).toEqual(['spec', 'quality']);
  });
  it('annotator path -> annotated when verdict=annotated', () => {
    expect(a.aggregate({ reviewPolicy: 'quality_only', annotatorVerdict: 'annotated' }).overallReviewVerdict).toBe('annotated');
  });
  it('annotator transport error -> not_applicable (deriver decides via errorCode separately)', () => {
    expect(a.aggregate({ reviewPolicy: 'quality_only', annotatorVerdict: 'error' }).overallReviewVerdict).toBe('not_applicable');
  });
});
