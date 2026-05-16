import { describe, it, expect } from 'vitest';
import { annotator } from '../../../packages/core/src/lifecycle/handlers/annotate-stage.js';

describe('annotator (unified)', () => {
  it('produces uniform report for write tasks', async () => {
    const state: any = {
      route: 'delegate',
      lastRunResult: {
        output: 'worker text',
        summary: 'did the thing', workerStatus: 'done',
        filesChanged: ['a.ts'],
        validationsRun: [{ name: 'npm test', passed: true, output: '' }],
        unresolved: [],
        committed: true,
        commitSha: 'a'.repeat(40),
        commitMessage: 'feat: add x',
        commitSkipReason: null,
      },
      reviewVerdict: 'approved',
      reviewConcerns: [],
      reworkApplied: false,
    };
    await annotator(state);
    const report = (state as any).structuredReport;
    expect(report.summary).toBe('did the thing');
    expect(report.findings).toEqual([]);
    expect(report.commitSha).toBe('a'.repeat(40));
    expect(report.commitMessage).toBe('feat: add x');
    expect(report.reviewVerdict).toBe('approved');
    expect(report.criteriaErrors).toEqual([]);
  });

  it('produces uniform report for read tasks', async () => {
    const state: any = {
      route: 'audit',
      lastRunResult: {
        findings: [{ severity: 'high', category: 'x', claim: 'y' }],
        criteriaErrors: [{ criterionId: '3', error: 'transport' }],
      },
    };
    await annotator(state);
    const report = (state as any).structuredReport;
    expect(report.findings).toHaveLength(1);
    expect(report.filesChanged).toEqual([]);
    expect(report.reviewVerdict).toBeNull();
    expect(report.criteriaErrors).toHaveLength(1);
  });

  it('null-safe defaults for write tasks with skipped commit', async () => {
    const state: any = {
      route: 'delegate',
      lastRunResult: {
        summary: 'no changes', workerStatus: 'done',
        filesChanged: [], validationsRun: [], unresolved: [],
        committed: false, commitSha: null, commitMessage: null, commitSkipReason: 'no_diff',
      },
      reviewVerdict: 'approved', reviewConcerns: [],
    };
    await annotator(state);
    const report = (state as any).structuredReport;
    expect(report.commitSkipReason).toBe('no_diff');
    expect(report.commitSha).toBeNull();
  });

  it('records annotating stage stats as a transformed zero-cost stage', async () => {
    const state: any = {
      route: 'audit',
      lastRunResult: {
        findings: [],
      },
    };

    await annotator(state);

    expect(state.lastRunResult?.stageStats?.annotating?.entered).toBe(true);
    expect(state.lastRunResult?.stageStats?.annotating?.outcome).toBe('transformed');
    expect(state.lastRunResult?.stageStats?.annotating?.costUSD).toBe(0);
    expect(state.lastRunResult?.stageStats?.annotating?.durationMs).toBeGreaterThanOrEqual(0);
  });
});
