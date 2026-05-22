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
        unresolved: [],
      },
      // Commit data is authoritative from the commit GATE payload (the commit
      // handler writes it there, not into lastRunResult).
      gates: {
        commit: {
          outcome: 'advance',
          payload: { kind: 'committed', commitSha: 'a'.repeat(40), commitMessage: 'feat: add x', filesChanged: ['a.ts'] },
        },
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
        filesChanged: [], unresolved: [],
      },
      // Skipped commit surfaces via the gate's no_op payload reason.
      gates: {
        commit: { outcome: 'advance', payload: { kind: 'no_op', reason: 'no_diff' } },
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
