import { describe, expect, it } from 'vitest';
import { runDiffReview, type DiffReviewVerdict } from '@zhixuan92/multi-model-agent-core/review/diff-review';
import type { VerifyStageResult } from '@zhixuan92/multi-model-agent-core/run-tasks/verify-stage';

const verification: VerifyStageResult = {
  status: 'passed',
  steps: [],
  totalDurationMs: 0,
};

function workerReturning(output: string): { call: (prompt: string) => Promise<{ output: string }> } {
  return {
    async call(): Promise<{ output: string }> {
      return { output };
    },
  };
}

function makeInput(output: string) {
  return {
    cwd: '/tmp',
    diff: 'diff --git a/x b/x\n',
    diffTruncated: false,
    verification,
    worker: workerReturning(output),
  };
}

describe('runDiffReview', () => {
  it('approves when reviewer mock returns approve', async () => {
    const verdict: DiffReviewVerdict = await runDiffReview(makeInput('APPROVE'));

    expect(verdict.kind).toBe('approve');
    expect(verdict.concerns).toEqual([]);
  });

  it('returns concerns kind when reviewer flags any issue', async () => {
    const verdict = await runDiffReview(makeInput('CONCERNS: unused import'));

    expect(verdict.kind).toBe('concerns');
    expect(verdict.concerns).toHaveLength(1);
    expect(verdict.concerns[0]).toEqual({
      source: 'diff_review',
      severity: 'medium',
      message: 'unused import',
    });
  });

  it('returns reject kind for clear rejection', async () => {
    const verdict = await runDiffReview(makeInput('REJECT: breaks API contract'));

    expect(verdict.kind).toBe('reject');
    expect(verdict.message).toContain('contract');
  });
});
