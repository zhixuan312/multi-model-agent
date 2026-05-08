import { describe, it, expect } from 'vitest';
import { debugHeadlineTemplate } from '../../packages/core/src/reporting/headline-templates/debug.js';
import type { RunResult, TaskSpec } from '../../packages/core/src/types.js';
import { notApplicable } from '../../packages/core/src/reporting/not-applicable.js';

// Tool sweep #4 — debug route headline rewrite (run id b228f9df).
//
// Pre-fix: emitted "debug: 1/1 tasks complete" with no [<status>] prefix
// and no findings count, breaking parity with audit/review/verify and
// hiding the actual diagnostic signal (worker had produced 3 narrative
// findings, annotator captured all 3, headline reported none).
//
// Post-fix: format mirrors audit —
//   [<status>] debug <path>: N findings (M high)
//   [<status>] debug completed   (only when no path AND no findings)

describe('debug headline composer (tool sweep #4)', () => {
  it('emits [status] debug <path>: N findings (M high) when annotator returned findings', () => {
    const runResult = {
      annotatedFindings: [
        { id: 'F1', claim: 'a', evidence: '', severity: 'high' },
        { id: 'F2', claim: 'b', evidence: '', severity: 'medium' },
        { id: 'F3', claim: 'c', evidence: '', severity: 'low' },
      ],
    } as unknown as RunResult;
    const task = { prompt: '', filePaths: ['/src/headline-text.ts'] } as unknown as TaskSpec;

    const headline = debugHeadlineTemplate.compose({
      taskBrief: 'debug',
      report: notApplicable('debug never emits a structured report'),
      status: 'ok',
      runResult,
      task,
    });

    expect(headline).toBe('[ok] debug /src/headline-text.ts: 3 findings (1 high)');
  });

  it('counts critical AND high together (parallel to audit)', () => {
    const runResult = {
      annotatedFindings: [
        { severity: 'critical' },
        { severity: 'high' },
        { severity: 'low' },
      ],
    } as unknown as RunResult;

    const headline = debugHeadlineTemplate.compose({
      taskBrief: 'debug',
      report: notApplicable('na'),
      status: 'ok',
      runResult,
      task: { prompt: '', filePaths: ['/x.ts'] } as unknown as TaskSpec,
    });

    expect(headline).toBe('[ok] debug /x.ts: 3 findings (2 high)');
  });

  it('falls back to parseNarrativeFindings(output) when annotatedFindings is empty', () => {
    const runResult = {
      annotatedFindings: [],
      output: `## Finding 1: x
- Severity: high
- Hypothesis: y
- Evidence: e
- Fix: f

## Finding 2: y
- Severity: low
- Hypothesis: z
- Evidence: e
- Fix: f
`,
    } as unknown as RunResult;
    const task = { prompt: '', filePaths: ['/src/x.ts'] } as unknown as TaskSpec;

    const headline = debugHeadlineTemplate.compose({
      taskBrief: 'debug',
      report: notApplicable('na'),
      status: 'ok',
      runResult,
      task,
    });

    expect(headline).toBe('[ok] debug /src/x.ts: 2 findings (1 high)');
  });

  it('returns "[ok] debug completed" when no findings AND no path', () => {
    const headline = debugHeadlineTemplate.compose({
      taskBrief: 'debug',
      report: notApplicable('na'),
      status: 'ok',
      runResult: { annotatedFindings: [] } as unknown as RunResult,
    });

    expect(headline).toBe('[ok] debug completed');
  });

  it('emits "[error] debug <path>: 0 findings (0 high)" on error status with path', () => {
    const headline = debugHeadlineTemplate.compose({
      taskBrief: 'debug',
      report: notApplicable('na'),
      status: 'error',
      runResult: { annotatedFindings: [] } as unknown as RunResult,
      task: { prompt: '', filePaths: ['/x.ts'] } as unknown as TaskSpec,
    });

    expect(headline).toBe('[error] debug /x.ts: 0 findings (0 high)');
  });
});
