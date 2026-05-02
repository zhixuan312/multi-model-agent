import { describe, expect, it } from 'vitest';
import { composeExploreHeadline } from '../../packages/core/src/reporting/compose-explore-headline.js';

describe('composeExploreHeadline', () => {
  it('happy path 4 threads', () => {
    expect(composeExploreHeadline({ taskCount: 3, failedCount: 0, threadCount: 4 }))
      .toBe('explore: 3/3 tasks complete; 4 threads');
  });
  it('one fail', () => {
    expect(composeExploreHeadline({ taskCount: 3, failedCount: 1, threadCount: 3 }))
      .toBe('explore: 1/3 tasks failed; synthesized with degraded inputs (3 threads)');
  });
  it('both fail', () => {
    expect(composeExploreHeadline({ taskCount: 3, failedCount: 2, threadCount: 0 }))
      .toBe('explore: external + internal both failed');
  });
  it('synthesizer fails after both workers succeed', () => {
    expect(composeExploreHeadline({ taskCount: 3, failedCount: 0, threadCount: 0, synthFailed: true }))
      .toBe('explore: synthesizer failed; worker outputs preserved');
  });
});
