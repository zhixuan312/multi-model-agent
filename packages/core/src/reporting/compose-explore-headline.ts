export interface HeadlineInput {
  taskCount: number;
  /**
   * How many of the parallel workers (internal #0, external #1) failed.
   * Only 0, 1, or 2 are valid — there are exactly two parallel workers.
   * The function asserts this; out-of-range values throw, since they
   * indicate a programmer error in the caller.
   */
  failedCount: number;
  threadCount: number;
  synthFailed?: boolean;       // synthesizer failed after both workers succeeded
}

export function composeExploreHeadline(i: HeadlineInput): string {
  if (i.failedCount < 0 || i.failedCount > 2 || !Number.isInteger(i.failedCount)) {
    throw new Error(`composeExploreHeadline: failedCount must be 0, 1, or 2 (got ${i.failedCount})`);
  }
  if (i.synthFailed) return 'explore: synthesizer failed; worker outputs preserved';
  if (i.failedCount === 0) return `explore: ${i.taskCount}/${i.taskCount} tasks complete; ${i.threadCount} threads`;
  if (i.failedCount === 2) return 'explore: external + internal both failed';
  // failedCount === 1
  return `explore: ${i.failedCount}/${i.taskCount} tasks failed; synthesized with degraded inputs (${i.threadCount} threads)`;
}
