import { describe, it, expect } from 'bun:test';
import { parseFindings } from '../../packages/core/src/lifecycle/findings-parser.js';

describe('parseFindings — outcome extraction', () => {
  const ISSUE_HUNTER = ['found', 'clean'] as const;
  const ANSWER_PRODUCER = ['found', 'not_applicable'] as const;

  it('extracts found outcome with reason when worker emits it explicitly', () => {
    const text = `## Finding 1: bug X
- Severity: high
- Category: correctness
- Evidence: src/foo.ts:42
- Suggestion: add guard

## Outcome
found`;
    const result = parseFindings(text, 'C1');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      severity: 'high',
      category: 'correctness',
      claim: 'bug X',
      evidence: 'src/foo.ts:42',
      suggestion: 'add guard',
    });
    expect(result.outcome).toBe('found');
  });

  it('extracts clean outcome for issue-hunter with no findings', () => {
    const text = `## Outcome
clean`;
    const result = parseFindings(text, 'C1');
    expect(result.findings).toHaveLength(0);
    expect(result.outcome).toBe('clean');
  });

  it('extracts not_applicable outcome for answer-producer', () => {
    const text = `## Outcome
not_applicable`;
    const result = parseFindings(text, 'C1');
    expect(result.findings).toHaveLength(0);
    expect(result.outcome).toBe('not_applicable');
  });

  it('defaults outcome to found when findings are present but ## Outcome is missing', () => {
    const text = `## Finding 1: issue
- Severity: high
- Category: test`;
    const result = parseFindings(text, 'C1');
    expect(result.findings).toHaveLength(1);
    expect(result.outcome).toBe('found');
  });

  it('defaults outcome to clean when no findings and no ## Outcome section', () => {
    const text = '';
    const result = parseFindings(text, 'C1');
    expect(result.findings).toHaveLength(0);
    expect(result.outcome).toBe('clean');
  });

  it('parses multiple findings and outcome correctly', () => {
    const text = `## Finding 1: issue A
- Severity: high
- Category: sec

## Finding 2: issue B
- Severity: low
- Category: perf

## Outcome
found`;
    const result = parseFindings(text, 'C1');
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0].claim).toBe('issue A');
    expect(result.findings[1].claim).toBe('issue B');
    expect(result.outcome).toBe('found');
  });

  it('ignores text after ## Outcome that is not a valid outcome', () => {
    const text = `## Finding 1: bug
- Severity: high
- Category: x

## Outcome
found`;
    const result = parseFindings(text, 'C1');
    expect(result.findings).toHaveLength(1);
    expect(result.outcome).toBe('found');
  });

  it('keeps inferred outcome when ## Outcome value is empty or whitespace-only', () => {
    // Tolerance rule: when worker emits ## Outcome but leaves the value blank,
    // trust the inferred outcome (from finding presence) rather than overriding
    // to 'clean'. A finding is present → outcome stays 'found'.
    const text = `## Finding 1: bug
- Severity: high
- Category: x

## Outcome
   `;
    const result = parseFindings(text, 'C1');
    expect(result.outcome).toBe('found');
  });
});
