import { describe, it, expect } from 'vitest';
import { parseFindings } from '../../packages/core/src/lifecycle/findings-parser.js';

describe('parseFindings', () => {
  it('extracts a single finding with all fields', () => {
    const out = parseFindings([
      '## Finding 1: SQL injection in login handler',
      '- Severity: high',
      '- Category: security',
      '- Issue: User input concatenated into query string',
      '- Suggestion: Use prepared statements',
    ].join('\n'), 'C1');
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toMatchObject({
      severity: 'high', category: 'security', claim: 'SQL injection in login handler',
      evidence: 'User input concatenated into query string', suggestion: 'Use prepared statements',
    });
  });
  it('defaults severity to medium when absent', () => {
    expect(parseFindings('## Finding 1: A thing\n- Category: x', 'C1').findings[0].severity).toBe('medium');
  });
  it('defaults category to criterion id when absent', () => {
    expect(parseFindings('## Finding 1: A thing\n- Severity: low', 'criterion-7').findings[0].category).toBe('criterion-7');
  });
  it('drops [N/A] findings', () => {
    const text = '## Finding 1: [N/A] no\n- Severity: low\n## Finding 2: real\n- Severity: high';
    const out = parseFindings(text, 'C1');
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].claim).toBe('real');
  });
  it('returns empty findings for empty input', () => {
    expect(parseFindings('', 'C1').findings).toEqual([]);
  });
  it('parses multiple findings in source order', () => {
    const out = parseFindings('## Finding 1: first\n- Severity: high\n## Finding 2: second\n- Severity: low', 'C1');
    expect(out.findings.map(f => f.claim)).toEqual(['first', 'second']);
  });
});
