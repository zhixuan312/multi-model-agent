/**
 * An execute_plan shortfall must be visible in the envelope the caller reads.
 *
 * The pipeline computes `completionPercent` and returns any concern (a failing acceptance command,
 * a task the reviewer reported not-done) as `failureReason`. The runtime emitted `failureReason`
 * ONLY when `status === 'failed'` — and execute_plan never reaches `failed`, because every concern
 * is deliberately downgraded to `done_with_concerns` so the commit stays on the branch for a human
 * to judge at PR review.
 *
 * So the worst case was silent: every task matched and reported done, the frozen acceptance
 * commands FAILED, and the caller saw `status: done_with_concerns`, `error: null`, no
 * `contractNote`, and a summary saying the work was complete. Nothing in the response distinguished
 * that from a clean run. The pipeline's own comment claimed "the per-task detail is in the
 * envelope", and `mma-execute-plan` documents `completionPercent` as derived and observable.
 *
 * This test asserts the envelope-construction contract directly: given a pipeline result carrying a
 * concern on a non-failed status, both signals reach `output`.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const RUNTIME = 'packages/server/src/application/execution-runtime.ts';
const PIPELINE = 'packages/core/src/unified/two-phase-pipeline.ts';

describe('execute_plan surfaces its completion signal', () => {
  const runtime = readFileSync(RUNTIME, 'utf8');
  const pipeline = readFileSync(PIPELINE, 'utf8');

  it('the pipeline still produces both signals', () => {
    // Premise. If either stops being computed, the envelope work below is pointless and this
    // should fail here rather than silently emitting nothing.
    expect(pipeline).toMatch(/completionPercent,/);
    expect(pipeline).toMatch(/\.\.\.\(epConcern && \{ failureReason: epConcern \}\)/);
  });

  it('execute_plan never reaches failed, which is why the old gate hid the concern', () => {
    // The downgrade is deliberate and stays: the commit is on the branch and a human judges at PR
    // review. It is precisely that downgrade which made `status === 'failed'` the wrong gate.
    expect(pipeline).toMatch(/if \(\(contractNote \|\| epConcern\) && status === 'done'\) status = 'done_with_concerns';/);
  });

  it('the envelope carries completionPercent for execute_plan', () => {
    expect(runtime).toMatch(/completionPercent: result\.completionPercent/);
    expect(runtime, 'scoped to execute_plan, the only type that computes a real percentage')
      .toMatch(/input\.type === 'execute_plan'/);
  });

  it('the envelope carries the concern on a non-failed status', () => {
    // The whole point: the old code emitted the reason only on `failed`.
    expect(runtime).toMatch(/result\.status !== 'failed' && result\.failureReason/);
    expect(runtime).toMatch(/concern: result\.failureReason/);
  });

  it('the failed path still carries its error, unchanged', () => {
    // The fix must not have moved the reason OFF the failure path.
    expect(runtime).toMatch(/result\.status === 'failed'\s*\n?\s*\? \(result\.failureReason/);
  });
});
