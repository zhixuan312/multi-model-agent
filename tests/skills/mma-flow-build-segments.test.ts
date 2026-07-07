import { describe, expect, it } from 'vitest';
import path from 'node:path';

const reviewSegmentPath = path.resolve('packages/server/src/skills/mma-flow/workflows/segment-review.js');
const executeSegmentPath = path.resolve('packages/server/src/skills/mma-flow/workflows/segment-execute.js');

describe('mma-flow build segments', () => {
  it('reviews the source-branch diff with the shared three-round policy', async () => {
    const { buildCompareRange, runSegmentReview } = await import(reviewSegmentPath);
    expect(buildCompareRange('main')).toBe('main...HEAD');

    let reviews = 0;
    let fixes = 0;
    const runtime = {
      log: () => undefined,
      phase: async (_name: string, fn: () => Promise<unknown>) => fn(),
      agent: async (request: { skill: string }) => {
        if (request.skill === 'mma-review') {
          reviews += 1;
          return reviews === 1
            ? {
                findingsSummary: 'needs review fixes',
                findings: ['critical diff bug'],
                counts: { critical: 1, high: 0, medium: 0, low: 0 },
                contextBlockId: 'cb-review-1',
              }
            : {
                findingsSummary: 'clean review',
                findings: [],
                counts: { critical: 0, high: 0, medium: 1, low: 0 },
                contextBlockId: 'cb-review-2',
              };
        }
        fixes += 1;
        return { applied: true };
      },
    };

    const result = await runSegmentReview(
      { cwd: '/repo', sourceBranch: 'main', autofix: true, cap: 3 },
      runtime,
    );

    expect(fixes).toBe(1);
    expect(result.roundsRun).toBe(2);
    expect(result.clean).toBe(true);
    expect(result.proceed).toBe(true);
    expect(result.blockingRemaining).toBe(false);
    expect(result.sourceBranch).toBe('main');
    expect(result.rounds.map((round: { fixedByAgent: boolean }) => round.fixedByAgent)).toEqual([true, false]);
  });

  it('normalizes branch slugs and falls back to task for empty titles', async () => {
    const { slugifySpecTitle } = await import(executeSegmentPath);

    expect(slugifySpecTitle('Cache / Queue parity!')).toBe('cache-queue-parity');
    expect(slugifySpecTitle('***')).toBe('task');
    expect(slugifySpecTitle('A very long title that should truncate after thirty characters total')).toBe('a-very-long-title-that-should');
  });

  it('maps locate signals to the earliest incomplete stage', async () => {
    const { pickResumeStage } = await import(executeSegmentPath);

    expect(pickResumeStage({
      latestSpecPath: null,
      latestPlanPath: null,
      gitRepoPresent: false,
      sourceBranch: null,
      projectBranch: null,
      projectBranchHasUniqueCommits: false,
      prExists: false,
      prMerged: false,
      deferredDecisionLedgerHasItems: false,
      currentSessionEvidence: { reviewPassed: false, wholeRepoGreen: false },
    })).toBe('D1');

    expect(pickResumeStage({
      latestSpecPath: 'docs/mma/specs/2026-07-07-demo.md',
      latestPlanPath: null,
      gitRepoPresent: false,
      sourceBranch: null,
      projectBranch: null,
      projectBranchHasUniqueCommits: false,
      prExists: false,
      prMerged: false,
      deferredDecisionLedgerHasItems: false,
      currentSessionEvidence: { reviewPassed: false, wholeRepoGreen: false },
    })).toBe('B1');

    expect(pickResumeStage({
      latestSpecPath: 'docs/mma/specs/2026-07-07-demo.md',
      latestPlanPath: 'docs/mma/plans/2026-07-07-demo.md',
      gitRepoPresent: true,
      sourceBranch: 'main',
      projectBranch: 'mma/demo',
      projectBranchHasUniqueCommits: true,
      prExists: false,
      prMerged: false,
      deferredDecisionLedgerHasItems: false,
      currentSessionEvidence: { reviewPassed: true, wholeRepoGreen: false },
    })).toBe('B7');
  });

  it('forwards grouped execute-plan dispatch on the current branch', async () => {
    const { runSegmentExecute } = await import(executeSegmentPath);
    const calls: Array<Record<string, unknown>> = [];
    const runtime = {
      phase: async (_name: string, fn: () => Promise<unknown>) => fn(),
      agent: async (request: Record<string, unknown>) => {
        calls.push(request);
        return { ok: true, taskId: 'task-123' };
      },
    };

    const result = await runSegmentExecute(
      { cwd: '/repo', planPath: '/repo/docs/mma/plans/demo.md', contextBlockIds: ['cb-1', 'cb-2'] },
      runtime,
    );

    expect(calls).toEqual([
      {
        skill: 'mma-execute-plan',
        cwd: '/repo',
        planPath: '/repo/docs/mma/plans/demo.md',
        contextBlockIds: ['cb-1', 'cb-2'],
      },
    ]);
    expect(result).toEqual({ ok: true, taskId: 'task-123' });
  });
});
