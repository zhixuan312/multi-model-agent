// tests/reporting/journal-recall-headline.test.ts
import { describe, expect, it } from 'vitest';
import type { RuntimeRunResult, TaskSpec } from '../../packages/core/src/types.js';
import { journalRecallHeadlineTemplate } from '../../packages/core/src/reporting/headline-templates/journal-recall.js';

const baseTask = { route: 'journal-recall', filePaths: [] } as unknown as TaskSpec;
const baseRun = { output: '', annotatedFindings: [] } as unknown as RuntimeRunResult;

describe('journalRecallHeadlineTemplate', () => {
  it('emits journal-recall:-prefixed headline with summary', () => {
    const headline = journalRecallHeadlineTemplate.compose({
      taskBrief: 'recall context',
      task: baseTask,
      report: {},
      runResult: { ...baseRun, output: 'Found important context from earlier discussion.' } as unknown as RuntimeRunResult,
      status: 'ok',
    });
    expect(headline).toBe('[ok] journal-recall: Found important context from earlier discussion.');
  });

  it('emits journal-recall:-prefixed headline without summary when output is empty', () => {
    const headline = journalRecallHeadlineTemplate.compose({
      taskBrief: 'recall context',
      task: baseTask,
      report: {},
      runResult: baseRun,
      status: 'ok',
    });
    expect(headline).toBe('[ok] journal-recall:');
  });

  it('emits journal-recall:-prefixed headline with truncated summary', () => {
    const longOutput = 'This is a long output that contains useful information. This is the second sentence that should not appear.';
    const headline = journalRecallHeadlineTemplate.compose({
      taskBrief: 'recall context',
      task: baseTask,
      report: {},
      runResult: { ...baseRun, output: longOutput } as unknown as RuntimeRunResult,
      status: 'ok',
    });
    expect(headline).toBe('[ok] journal-recall: This is a long output that contains useful information.');
  });

  it('emits journal-recall:-prefixed headline with error status', () => {
    const headline = journalRecallHeadlineTemplate.compose({
      taskBrief: 'recall context',
      task: baseTask,
      report: {},
      runResult: { ...baseRun, output: 'Failed to retrieve context.' } as unknown as RuntimeRunResult,
      status: 'error',
    });
    expect(headline).toBe('[error] journal-recall: Failed to retrieve context.');
  });
});
