import { describe, it, expect } from 'vitest';
import { verifyHeadlineTemplate } from '../../packages/core/src/reporting/headline-templates/verify.js';
import {
  parseVerifyResults,
  verifyReportSchema,
} from '../../packages/core/src/reporting/report-parser-slots/verify-report.js';
import { notApplicable } from '../../packages/core/src/reporting/not-applicable.js';
import type { RunResult, TaskSpec } from '../../packages/core/src/types.js';

// Tool sweep #3 — verify route gaps surfaced by batch 203db176.
//
// Worker correctly emitted four `## Finding N:` blocks with `- Result: PASS`
// per the prompt's explicit "Do NOT emit JSON" instruction. The verify
// schema parser required a JSON block, the parse failed, the headline
// composer reported `0/0 pass`, and the operator lost all signal.
//
// These tests pin the fixed behavior:
//   - parseVerifyResults extracts {item, pass, evidence} per block
//   - verifyReportSchema accepts both JSON and narrative forms
//   - verifyHeadlineTemplate falls back to runResult.output narrative
//     and prefers the structured form ([ok] verify <path>: 4/4 pass)
//     when a path is known.

describe('parseVerifyResults', () => {
  const sample = `## Finding 1: thing one passes
- Severity: low
- Item: criterion one
- Result: PASS
- Evidence: file.ts:10 shows ok

## Finding 2: thing two fails
- Severity: high
- Item: criterion two
- Result: FAIL
- Evidence: file.ts:20 missing guard
`;

  it('extracts one entry per `## Finding N:` block', () => {
    const out = parseVerifyResults(sample);
    expect(out).toHaveLength(2);
  });

  it('parses Item / Result / Evidence per block', () => {
    const out = parseVerifyResults(sample);
    expect(out[0]).toEqual({
      item: 'criterion one',
      pass: true,
      evidence: 'file.ts:10 shows ok',
    });
    expect(out[1]).toEqual({
      item: 'criterion two',
      pass: false,
      evidence: 'file.ts:20 missing guard',
    });
  });

  it('treats Result case-insensitively (Pass / pass / PASS)', () => {
    const out = parseVerifyResults(`## Finding 1: x
- Item: a
- Result: Pass
- Evidence: e

## Finding 2: y
- Item: b
- Result: pass
- Evidence: e
`);
    expect(out.every((x) => x.pass)).toBe(true);
  });

  it('returns [] for empty / non-string input', () => {
    expect(parseVerifyResults('')).toEqual([]);
    expect(parseVerifyResults(undefined as unknown as string)).toEqual([]);
    expect(parseVerifyResults('no findings here')).toEqual([]);
  });

  it('records pass=false when the Result label is missing', () => {
    const out = parseVerifyResults(`## Finding 1: x
- Item: a
- Evidence: e
`);
    expect(out).toEqual([{ item: 'a', pass: false, evidence: 'e' }]);
  });
});

describe('verifyReportSchema.parse', () => {
  it('still accepts a JSON block (legacy back-compat)', () => {
    const text = '\n```json\n{ "results": [{"item":"a","pass":true,"evidence":"e"}] }\n```';
    const r = verifyReportSchema.parse(text);
    expect(r.results).toEqual([{ item: 'a', pass: true, evidence: 'e' }]);
  });

  it('parses narrative `## Finding N:` when no JSON block is present', () => {
    const text = `## Finding 1: x
- Item: a
- Result: PASS
- Evidence: e
`;
    const r = verifyReportSchema.parse(text);
    expect(r.results).toEqual([{ item: 'a', pass: true, evidence: 'e' }]);
  });

  it('throws when neither path produces results (so parent falls back to notApplicable)', () => {
    expect(() => verifyReportSchema.parse('no findings, no JSON')).toThrow();
  });
});

describe('verifyHeadlineTemplate', () => {
  it('emits structured "X/Y pass" with file path when results are present', () => {
    const task = { prompt: '', filePaths: ['/src/auth.ts'] } as unknown as TaskSpec;
    const headline = verifyHeadlineTemplate.compose({
      taskBrief: 'verify',
      report: {
        results: [
          { item: 'a', pass: true, evidence: '' },
          { item: 'b', pass: true, evidence: '' },
          { item: 'c', pass: false, evidence: '' },
        ],
      },
      status: 'ok',
      task,
    });
    expect(headline).toBe('[ok] verify /src/auth.ts: 2/3 pass');
  });

  it('falls back to runResult.output narrative when report.results is empty', () => {
    // The actual tool sweep #3 case: report carried a generic
    // structured-report shape (no `results`), but the worker had
    // already produced 4 valid `## Finding N:` blocks in its output.
    const task = { prompt: '', filePaths: ['/src/x.ts'] } as unknown as TaskSpec;
    const runResult = {
      output: `## Finding 1: a
- Severity: low
- Item: a
- Result: PASS
- Evidence: e

## Finding 2: b
- Severity: low
- Item: b
- Result: PASS
- Evidence: e

## Finding 3: c
- Severity: low
- Item: c
- Result: PASS
- Evidence: e

## Finding 4: d
- Severity: low
- Item: d
- Result: PASS
- Evidence: e
`,
    } as unknown as RunResult;

    const headline = verifyHeadlineTemplate.compose({
      taskBrief: 'verify',
      report: notApplicable('schema parse failed'),
      status: 'ok',
      runResult,
      task,
    });
    expect(headline).toBe('[ok] verify /src/x.ts: 4/4 pass');
  });

  it('collapses to "verify completed" only with no results AND no path', () => {
    const headline = verifyHeadlineTemplate.compose({
      taskBrief: 'verify',
      report: notApplicable('na'),
      status: 'ok',
    });
    expect(headline).toBe('[ok] verify completed');
  });

  it('with path but no results, still emits structured "0/0 pass" form (signal that nothing parsed)', () => {
    const task = { prompt: '', filePaths: ['/src/x.ts'] } as unknown as TaskSpec;
    const headline = verifyHeadlineTemplate.compose({
      taskBrief: 'verify',
      report: notApplicable('na'),
      status: 'ok',
      task,
    });
    expect(headline).toBe('[ok] verify /src/x.ts: 0/0 pass');
  });

  it('error status with results still reports structured headline', () => {
    const task = { prompt: '', filePaths: ['/src/x.ts'] } as unknown as TaskSpec;
    const headline = verifyHeadlineTemplate.compose({
      taskBrief: 'verify',
      report: { results: [{ item: 'a', pass: false, evidence: '' }] },
      status: 'error',
      task,
    });
    expect(headline).toBe('[error] verify /src/x.ts: 0/1 pass');
  });
});
