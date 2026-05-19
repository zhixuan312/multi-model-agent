import { describe, it, expect } from 'vitest';
import { parseReviewReport } from '../../packages/core/src/review/parse-review-report.js';

describe('parse-review-report', () => {
  it('extracts ## Finding N: blocks + Verdict line', () => {
    const reviewerOutput = `## Verdict

approved

## Findings

## Finding 1:
- Severity: high
- Category: correctness
- Claim: The function does not handle the case where input is undefined
- Evidence: The code path at src/foo.ts:42 silently returns undefined instead of raising an error
- Suggestion: Add a guard clause at the top of the function

## Finding 2:
- Severity: medium
- Category: style
- Claim: Inconsistent naming convention
- Evidence: Mixed camelCase and snake_case variable names in the same scope
`;

    const result = parseReviewReport(reviewerOutput);

    // Per design spec §4: approved + findings → changes_required
    // The Verdict line says "approved" but findings presence downgrades it
    expect(result.verdict).toBe('changes_required');
    expect(result.findings).toHaveLength(2);

    expect(result.findings[0].severity).toBe('high');
    expect(result.findings[0].category).toBe('correctness');
    expect(result.findings[0].claim).toBe('The function does not handle the case where input is undefined');
    expect(result.findings[0].evidence).toBe('The code path at src/foo.ts:42 silently returns undefined instead of raising an error');
    expect(result.findings[0].suggestion).toBe('Add a guard clause at the top of the function');

    expect(result.findings[1].severity).toBe('medium');
    expect(result.findings[1].category).toBe('style');
    expect(result.findings[1].claim).toBe('Inconsistent naming convention');
    expect(result.findings[1].evidence).toBe('Mixed camelCase and snake_case variable names in the same scope');
    expect(result.findings[1].suggestion).toBeUndefined();
  });

  it('sets verdict to changes_required when deviations are present alongside approved', () => {
    const reviewerOutput = `
## Verdict

approved

## Findings

## Finding 1:
- Severity: critical
- Category: security
- Claim: SQL injection vulnerability in the query builder
- Evidence: User input is concatenated directly into the SQL string without parameterization
- Suggestion: Use parameterized queries instead
`;

    const result = parseReviewReport(reviewerOutput);

    // approved + findings → changes_required per design spec
    expect(result.verdict).toBe('changes_required');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe('critical');
  });

  it('handles verdict=changes_required without findings', () => {
    const reviewerOutput = `
## Verdict

changes_required

## Findings

(no deviations)
`;

    const result = parseReviewReport(reviewerOutput);
    expect(result.verdict).toBe('changes_required');
    expect(result.findings).toHaveLength(0);
  });

  it('falls back to changes_required when no verdict header is present', () => {
    const result = parseReviewReport('some unparseable output with no header');
    expect(result.verdict).toBe('changes_required');
    expect(result.findings).toHaveLength(0);
  });

  it('parses severity defaults to medium when missing', () => {
    const reviewerOutput = `
## Verdict

changes_required

## Findings

## Finding 1:
- Category: correctness
- Claim: Something is wrong but severity was not specified
`;

    const result = parseReviewReport(reviewerOutput);
    expect(result.verdict).toBe('changes_required');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe('medium');
    expect(result.findings[0].category).toBe('correctness');
  });

  it('keeps verdict=approved when only low/medium findings are present (severity gate)', () => {
    // The reviewer prompt is explicit that medium/low findings do not block
    // ship. A cooperative LLM that approves + lists nice-to-fix nits should
    // stay approved — the parser must not override to changes_required and
    // trigger a full rework cycle for a single low-severity nit.
    const reviewerOutput = `## Verdict

approved

## Findings

## Finding 1:
- Severity: low
- Category: style
- Claim: Variable name could be more descriptive
- Evidence: The local var \`x\` could be \`itemCount\`

## Finding 2:
- Severity: medium
- Category: docs
- Claim: Missing JSDoc on exported function
- Evidence: foo() has no doc comment
`;
    const result = parseReviewReport(reviewerOutput);
    expect(result.verdict).toBe('approved');
    expect(result.findings).toHaveLength(2);
  });

  it('flips to changes_required when at least one critical/high finding is present', () => {
    // Mixed bag: one high blocker + one low nit. The high blocker must
    // flip the verdict; the low nit alone would not have.
    const reviewerOutput = `## Verdict

approved

## Findings

## Finding 1:
- Severity: low
- Category: style
- Claim: Minor naming nit
- Evidence: var \`x\`

## Finding 2:
- Severity: high
- Category: correctness
- Claim: Off-by-one in loop bound
- Evidence: \`for (i=0; i<=n; i++)\` should be \`<\`
`;
    const result = parseReviewReport(reviewerOutput);
    expect(result.verdict).toBe('changes_required');
    expect(result.findings).toHaveLength(2);
  });

  it('skips findings with [N/A] claim', () => {
    const reviewerOutput = `
## Verdict

approved

## Findings

## Finding 1:
- Severity: high
- Category: correctness
- Claim: [N/A] No issues found in this criterion

## Finding 2:
- Severity: high
- Category: correctness
- Claim: Actual issue here
- Evidence: The code is broken
`;

    const result = parseReviewReport(reviewerOutput);
    // [N/A] finding is skipped by parseFindings; verdict overridden to changes_required by approved+findings rule
    expect(result.verdict).toBe('changes_required');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].claim).toBe('Actual issue here');
  });
});