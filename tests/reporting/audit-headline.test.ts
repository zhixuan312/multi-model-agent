import { describe, it, expect } from 'bun:test';
import { makeFindingsHeadlineTemplate } from '../../packages/core/src/reporting/findings-headline.js';
const auditHeadlineTemplate = makeFindingsHeadlineTemplate('audit', 'high');
const reviewHeadlineTemplate = makeFindingsHeadlineTemplate('review', 'blocking');
import type { RuntimeRunResult, TaskSpec } from '../../packages/core/src/types.js';
import { notApplicable } from '../../packages/core/src/reporting/not-applicable.js';

describe('audit headline composer', () => {
  it('counts findings from runResult.output (## Finding N: blocks) when report has none', () => {
    // v4.5.2+: read-only-route headlines fall back to parseNarrativeFindings
    // on runResult.output (no separate annotator pass anymore). The narrative
    // is the canonical source when the worker emits `## Finding N:` blocks
    // without a structured report.
    const runResult = {
      output: `## Finding 1: a
- Severity: high

## Finding 2: b
- Severity: medium

## Finding 3: c
- Severity: low

## Finding 4: d
- Severity: critical
`,
    } as unknown as RuntimeRunResult;
    const task = { prompt: 'audit goal.md', filePaths: ['/project/goal.md'] } as unknown as TaskSpec;

    const headline = auditHeadlineTemplate.compose({
      taskBrief: 'audit',
      report: notApplicable('reportSchema.parse failed'),
      status: 'ok',
      runResult,
      task,
    });

    // 4 findings, 2 high (high + critical aggregated per countHighOrCritical).
    expect(headline).toBe('[ok] audit /project/goal.md: 4 findings (2 high)');
  });

  it('case-insensitive on severity (round-2 F10/F1)', () => {
    const runResult = {
      output: `## Finding 1: a
- Severity: High

## Finding 2: b
- Severity: CRITICAL

## Finding 3: c
- Severity: medium
`,
    } as unknown as RuntimeRunResult;
    const task = { prompt: '', filePaths: ['/x.md'] } as unknown as TaskSpec;

    const headline = auditHeadlineTemplate.compose({
      taskBrief: 'audit',
      report: notApplicable('na'),
      status: 'ok',
      runResult,
      task,
    });

    expect(headline).toBe('[ok] audit /x.md: 3 findings (2 high)');
  });

  it('prefers report.findings over narrative when both present', () => {
    const runResult = {
      output: `## Finding 1: ignored-because-report-wins
- Severity: high

## Finding 2: also-ignored
- Severity: high
`,
    } as unknown as RuntimeRunResult;

    const headline = auditHeadlineTemplate.compose({
      taskBrief: 'audit',
      report: {
        documentPath: '/from/structured.md',
        findings: [
          { severity: 'low', category: 'style', message: 'x', evidenceQuote: '', annotatorConfidence: 50 },
        ],
      },
      status: 'ok',
      runResult,
    });

    // Structured report wins — 1 finding, 0 high.
    expect(headline).toBe('[ok] audit /from/structured.md: 1 findings (0 high)');
  });

  it('returns "audit completed" when no findings anywhere', () => {
    const headline = auditHeadlineTemplate.compose({
      taskBrief: 'audit',
      report: notApplicable('na'),
      status: 'ok',
      runResult: { output: '' } as unknown as RuntimeRunResult,
    });

    expect(headline).toBe('[ok] audit completed');
  });

  // Narrative-parse fallback: when the worker emits `## Finding N:` blocks
  // without a structured report (the common audit case), the headline is
  // derived directly from runResult.output. Validates the actual telemetry
  // id 854913 case where 2 valid narrative findings shipped.
  it('falls back to parseNarrativeFindings when no structured report present', () => {
    const runResult = {
      output: `## Finding 1: Regex chokes on internal periods
- Severity: medium
- Location: headline-text.ts:15

## Finding 2: Max param ignored
- Severity: low
- Location: headline-text.ts:15
`,
    } as unknown as RuntimeRunResult;
    const task = { prompt: '', filePaths: ['/a/b/headline-text.ts'] } as unknown as TaskSpec;

    const headline = auditHeadlineTemplate.compose({
      taskBrief: 'audit',
      report: notApplicable('reportSchema parse failed'),
      status: 'ok',
      runResult,
      task,
    });

    expect(headline).toBe('[ok] audit /a/b/headline-text.ts: 2 findings (0 high)');
  });
});

describe('review headline composer', () => {
  it('counts findings from runResult.output (## Finding N: blocks) when report has none', () => {
    const runResult = {
      output: `## Finding 1: a
- Severity: high

## Finding 2: b
- Severity: medium
`,
    } as unknown as RuntimeRunResult;
    const task = { prompt: '', filePaths: ['/src/auth.ts'] } as unknown as TaskSpec;

    const headline = reviewHeadlineTemplate.compose({
      taskBrief: 'review auth',
      report: notApplicable('na'),
      status: 'ok',
      runResult,
      task,
    });

    expect(headline).toBe('[ok] review /src/auth.ts: 2 findings (1 blocking)');
  });

  // review-tool sweep, Gap A (run id 02af2f9d):
  // When a clean review finds zero issues, the headline used to fall
  // back to `[${status}] review: ${taskBrief}` — and taskBrief is just
  // the route name "review", producing the operator-useless
  // "[ok] review: review". The fix mirrors audit: use the structured
  // form whenever a path is known, even with zero findings.
  it('Gap A: emits "0 findings (0 blocking)" with path when clean review on a file', () => {
    const task = { prompt: '', filePaths: ['/src/clean.ts'] } as unknown as TaskSpec;

    const headline = reviewHeadlineTemplate.compose({
      taskBrief: 'review',
      report: notApplicable('na'),
      status: 'ok',
      runResult: { output: 'No correctness findings identified.' } as unknown as RuntimeRunResult,
      task,
    });

    expect(headline).toBe('[ok] review /src/clean.ts: 0 findings (0 blocking)');
  });

  it('Gap A: also works when filePath comes from structured report instead of task', () => {
    const headline = reviewHeadlineTemplate.compose({
      taskBrief: 'review',
      report: { filePath: '/from/report.ts', findings: [] },
      status: 'ok',
      runResult: { output: "" } as unknown as RuntimeRunResult,
    });

    expect(headline).toBe('[ok] review /from/report.ts: 0 findings (0 blocking)');
  });

  it('Gap A: collapses to "review completed" only when no path AND no findings', () => {
    // No filePaths on task, no filePath on report, no findings — the
    // generic-completion fallback. Crucially this is NOT the
    // "review: review" bug.
    const headline = reviewHeadlineTemplate.compose({
      taskBrief: 'review',
      report: notApplicable('na'),
      status: 'ok',
      runResult: { output: "" } as unknown as RuntimeRunResult,
    });

    expect(headline).toBe('[ok] review completed');
  });

  it('Gap A: error status with path still reports structured headline', () => {
    const task = { prompt: '', filePaths: ['/src/x.ts'] } as unknown as TaskSpec;

    const headline = reviewHeadlineTemplate.compose({
      taskBrief: 'review',
      report: notApplicable('na'),
      status: 'error',
      runResult: { output: "" } as unknown as RuntimeRunResult,
      task,
    });

    expect(headline).toBe('[error] review /src/x.ts: 0 findings (0 blocking)');
  });
});
