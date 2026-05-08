import { describe, it, expect } from 'vitest';
import { auditHeadlineTemplate } from '../../packages/core/src/reporting/headline-templates/audit.ts';
import { reviewHeadlineTemplate } from '../../packages/core/src/reporting/headline-templates/review.ts';
import type { RunResult, TaskSpec } from '../../packages/core/src/types.js';
import { notApplicable } from '../../packages/core/src/reporting/not-applicable.js';

describe('audit headline composer (4.0.3+ Gap 2)', () => {
  it('counts findings from runResult.annotatedFindings when report has none', () => {
    // Pre-fix: composer only read report.findings. Worker emits narrative
    // → reportSchema fails → fallback to parseStructuredReport (no
    // findings field) → headline reported "0 findings" while annotator
    // returned dozens. The fix is to also read runResult.annotatedFindings.
    const runResult = {
      annotatedFindings: [
        { id: 'F1', claim: 'a', evidence: '', evidenceGrounded: true, annotatorConfidence: 90, severity: 'high' },
        { id: 'F2', claim: 'b', evidence: '', evidenceGrounded: true, annotatorConfidence: 80, severity: 'medium' },
        { id: 'F3', claim: 'c', evidence: '', evidenceGrounded: true, annotatorConfidence: 60, severity: 'low' },
        { id: 'F4', claim: 'd', evidence: '', evidenceGrounded: true, annotatorConfidence: 95, severity: 'critical' },
      ],
    } as unknown as RunResult;
    const task = { prompt: 'audit goal.md', filePaths: ['/project/goal.md'] } as unknown as TaskSpec;

    const headline = auditHeadlineTemplate.compose({
      taskBrief: 'audit',
      report: notApplicable('reportSchema.parse failed'),
      status: 'ok',
      runResult,
      task,
    });

    // Expect 4 findings, 2 high (high + critical aggregated per
    // countHighOrCritical helper).
    expect(headline).toBe('[ok] audit /project/goal.md: 4 findings (2 high)');
  });

  it('case-insensitive on severity (round-2 F10/F1)', () => {
    const runResult = {
      annotatedFindings: [
        { id: 'F1', claim: 'a', evidence: '', evidenceGrounded: true, annotatorConfidence: 90, severity: 'High' },
        { id: 'F2', claim: 'b', evidence: '', evidenceGrounded: true, annotatorConfidence: 80, severity: 'CRITICAL' },
        { id: 'F3', claim: 'c', evidence: '', evidenceGrounded: true, annotatorConfidence: 60, severity: 'medium' },
      ],
    } as unknown as RunResult;
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

  it('prefers report.findings over annotatedFindings when both present', () => {
    const runResult = {
      annotatedFindings: [
        { id: 'F1', claim: 'a', evidence: '', evidenceGrounded: true, annotatorConfidence: 90, severity: 'high' },
        { id: 'F2', claim: 'b', evidence: '', evidenceGrounded: true, annotatorConfidence: 80, severity: 'high' },
      ],
    } as unknown as RunResult;

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
      runResult: { annotatedFindings: [] } as unknown as RunResult,
    });

    expect(headline).toBe('[ok] audit completed');
  });

  // 4.0.3+ Gap 16: when annotator errors, fall back to parsing
  // ## Finding N: blocks from the implementer's output. Validates the
  // actual telemetry id 854913 case where annotator errored but the
  // implementer produced 2 valid narrative findings.
  it('falls back to parseNarrativeFindings when annotator errored (annotatedFindings empty)', () => {
    const runResult = {
      annotatedFindings: [],
      output: `## Finding 1: Regex chokes on internal periods
- Severity: medium
- Location: headline-text.ts:15

## Finding 2: Max param ignored
- Severity: low
- Location: headline-text.ts:15
`,
    } as unknown as RunResult;
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

describe('review headline composer (4.0.3+ Gap 2)', () => {
  it('counts findings from runResult.annotatedFindings when report has none', () => {
    const runResult = {
      annotatedFindings: [
        { id: 'F1', claim: 'a', evidence: '', evidenceGrounded: true, annotatorConfidence: 90, severity: 'high' },
        { id: 'F2', claim: 'b', evidence: '', evidenceGrounded: true, annotatorConfidence: 80, severity: 'medium' },
      ],
    } as unknown as RunResult;
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
});
