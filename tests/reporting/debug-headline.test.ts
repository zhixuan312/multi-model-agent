import { describe, it, expect } from 'vitest';
import { debugHeadlineTemplate } from '../../packages/core/src/reporting/headline-templates/debug.js';
import type { RuntimeRunResult, TaskSpec } from '../../packages/core/src/types.js';
import { notApplicable } from '../../packages/core/src/reporting/not-applicable.js';

// v4.5.2+ debug-headline format:
//   [<status>] debug <path>: N findings (M high)
//   [<status>] debug completed   (only when no path AND no findings)
//
// Findings are read directly from runResult.output via
// parseNarrativeFindings (the worker emits `## Finding N:` blocks; there
// is no separate annotator pass).

describe('debug headline composer', () => {
  it('emits [status] debug <path>: N findings (M high) from narrative output', () => {
    const runResult = {
      output: `## Finding 1: a
- Severity: high

## Finding 2: b
- Severity: medium

## Finding 3: c
- Severity: low
`,
    } as unknown as RuntimeRunResult;
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
      output: `## Finding 1: a
- Severity: critical

## Finding 2: b
- Severity: high

## Finding 3: c
- Severity: low
`,
    } as unknown as RuntimeRunResult;

    const headline = debugHeadlineTemplate.compose({
      taskBrief: 'debug',
      report: notApplicable('na'),
      status: 'ok',
      runResult,
      task: { prompt: '', filePaths: ['/x.ts'] } as unknown as TaskSpec,
    });

    expect(headline).toBe('[ok] debug /x.ts: 3 findings (2 high)');
  });

  it('returns "[ok] debug completed" when no findings AND no path', () => {
    const headline = debugHeadlineTemplate.compose({
      taskBrief: 'debug',
      report: notApplicable('na'),
      status: 'ok',
      runResult: { output: '' } as unknown as RuntimeRunResult,
    });

    expect(headline).toBe('[ok] debug completed');
  });

  it('emits "[error] debug <path>: 0 findings (0 high)" on error status with path', () => {
    const headline = debugHeadlineTemplate.compose({
      taskBrief: 'debug',
      report: notApplicable('na'),
      status: 'error',
      runResult: { output: '' } as unknown as RuntimeRunResult,
      task: { prompt: '', filePaths: ['/x.ts'] } as unknown as TaskSpec,
    });

    expect(headline).toBe('[error] debug /x.ts: 0 findings (0 high)');
  });
});
