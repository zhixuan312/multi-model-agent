import { describe, it, expect } from 'vitest';
import { delegateHeadlineTemplate } from '../../packages/core/src/reporting/headline-templates/delegate.js';
import type { RunResult } from '../../packages/core/src/types.js';
import { notApplicable } from '../../packages/core/src/reporting/not-applicable.js';

describe('delegate headline composer (Gaps 12 + 13)', () => {
  it('counts files from runResult.filesWritten when report.filesChanged is empty (Gap 13)', () => {
    // Reproduces telemetry id 854741: worker successfully edited a file
    // via edit_file, but emitted only `summary` (no filesChanged).
    // Pre-fix headline reported "(0 files)" — wrong.
    const runResult = {
      filesWritten: ['packages/core/src/lifecycle/stage-progression.ts'],
    } as unknown as RunResult;

    const headline = delegateHeadlineTemplate.compose({
      taskBrief: 'edit comment',
      report: {
        summary: 'The edit has been applied successfully.',
        filesChanged: [],
      },
      status: 'ok',
      runResult,
    });

    expect(headline).toBe('[ok] The edit has been applied successfully. (1 file)');
  });

  it('prefers report.filesChanged over runResult.filesWritten when both populated', () => {
    const runResult = {
      filesWritten: ['/x.ts', '/y.ts', '/z.ts'],
    } as unknown as RunResult;

    const headline = delegateHeadlineTemplate.compose({
      taskBrief: 'edit',
      report: {
        summary: 'Did the thing.',
        filesChanged: [{ path: '/x.ts' }],  // structured single file
      },
      status: 'ok',
      runResult,
    });

    // Structured report wins (1), not runResult (3).
    expect(headline).toBe('[ok] Did the thing. (1 file)');
  });

  it('truncates multi-sentence summary to first sentence (Gap 12)', () => {
    const runResult = { filesWritten: ['/a.ts'] } as unknown as RunResult;

    const headline = delegateHeadlineTemplate.compose({
      taskBrief: '',
      report: {
        summary: 'Edit complete. We changed three lines and added a JSDoc comment. The file now compiles.',
        filesChanged: [],
      },
      status: 'ok',
      runResult,
    });

    expect(headline).toBe('[ok] Edit complete. (1 file)');
  });

  it('handles "no structured report" envelope gracefully', () => {
    const headline = delegateHeadlineTemplate.compose({
      taskBrief: '',
      report: notApplicable('no output'),
      status: 'ok',
      runResult: { filesWritten: [] } as unknown as RunResult,
    });

    expect(headline).toBe('[ok] no structured report available');
  });

  it('still surfaces file count even when report is not_applicable but runResult has writes', () => {
    // E.g. worker emitted no structured report at all, but DID write files.
    const headline = delegateHeadlineTemplate.compose({
      taskBrief: '',
      report: notApplicable('parse failed'),
      status: 'ok',
      runResult: { filesWritten: ['/a.ts', '/b.ts'] } as unknown as RunResult,
    });

    expect(headline).toBe('[ok] (2 files)');
  });

  it('handles synthetic shell:<cmd> filesWritten entries (Gap 11 interop)', () => {
    // Gap 11 attributes shell-driven writes via synthetic
    // `shell:<cmd-prefix>` entries. Those should still count toward
    // the headline file count.
    const headline = delegateHeadlineTemplate.compose({
      taskBrief: '',
      report: { summary: 'Patched.', filesChanged: [] },
      status: 'ok',
      runResult: {
        filesWritten: ['shell:sed -i "s/old/new/" file.ts'],
      } as unknown as RunResult,
    });

    expect(headline).toBe('[ok] Patched. (1 file)');
  });
});
