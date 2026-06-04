// tests/reporting/headline-templates/research.test.ts
import { describe, expect, it } from 'vitest';
import type { RuntimeRunResult, TaskSpec } from '../../../packages/core/src/types.js';
import { researchHeadlineTemplate } from '../../../packages/core/src/reporting/headline-templates/research.js';

const baseTask = { route: 'research', filePaths: [] } as unknown as TaskSpec;
const baseRun = { output: '', annotatedFindings: [] } as unknown as RuntimeRunResult;

describe('researchHeadlineTemplate', () => {
  it('emits ok headline with source + finding counts', () => {
    const headline = researchHeadlineTemplate.compose({
      taskBrief: 'streaming JSON',
      task: baseTask,
      report: {
        findings: [{ index: 1, body: 'x', citations: [] }, { index: 2, body: 'y', citations: [] }],
        sourcesUsed: [{ source: 'arxiv', attempted: true, used: true }],
      },
      runResult: baseRun,
      status: 'ok',
    });
    expect(headline).toBe('[ok] research: 1 sources, 2 findings');
  });

  it('emits incomplete headline for timeout', () => {
    const headline = researchHeadlineTemplate.compose({
      taskBrief: 'x',
      task: baseTask,
      report: { findings: [], sourcesUsed: [] },
      runResult: { ...baseRun, incompleteReason: 'timeout' } as unknown as RuntimeRunResult,
      status: 'incomplete',
    });
    expect(headline).toBe('[incomplete] research: timed out');
  });

  it('emits incomplete headline for turn cap', () => {
    const headline = researchHeadlineTemplate.compose({
      taskBrief: 'x',
      task: baseTask,
      report: { findings: [], sourcesUsed: [] },
      runResult: { ...baseRun, incompleteReason: 'turn_cap' } as unknown as RuntimeRunResult,
      status: 'incomplete',
    });
    expect(headline).toBe('[incomplete] research: turn cap reached');
  });

  it('emits error headline with message', () => {
    const headline = researchHeadlineTemplate.compose({
      taskBrief: 'x',
      task: baseTask,
      report: { findings: [], sourcesUsed: [] },
      runResult: { ...baseRun, error: 'runner crashed: ECONNRESET' } as unknown as RuntimeRunResult,
      status: 'error',
    });
    expect(headline).toContain('[error] research:');
    expect(headline).toContain('ECONNRESET');
  });
});
