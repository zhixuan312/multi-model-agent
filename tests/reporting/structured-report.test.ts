import { describe, it, expect } from 'vitest';
import { structuredReportSuffix, parseStructuredReport } from '@zhixuan92/multi-model-agent-core/reporting/structured-report';

describe('structuredReportSuffix', () => {
  it('contains all six required section headers', () => {
    const s = structuredReportSuffix;
    expect(s).toContain('## Summary');
    expect(s).toContain('## Files changed');
    expect(s).toContain('## Normalization decisions');
    expect(s).toContain('## Validations run');
    expect(s).toContain('## Deviations from brief');
    expect(s).toContain('## Unresolved');
  });
});

describe('parseStructuredReport', () => {
  it('parses a well-formed report', () => {
    const output = `Some output text.

## Summary
Implemented the feature.

## Files changed
- src/auth.ts
- src/auth.test.ts

## Normalization decisions
- "the pattern" → src/users.ts:45

## Validations run
- tsc passes
- tests pass

## Deviations from brief
None.

## Unresolved
None.`;

    const r = parseStructuredReport(output);
    expect(r.summary).toBe('Implemented the feature.');
    expect(r.filesChanged).toEqual([
      { path: 'src/auth.ts', summary: '' },
      { path: 'src/auth.test.ts', summary: '' },
    ]);
    expect(r.normalizationDecisions).toEqual([['"the pattern" → src/users.ts:45']]);
    expect(r.validationsRun).toEqual([
      { command: 'tsc passes', result: '' },
      { command: 'tests pass', result: '' },
    ]);
    expect(r.deviationsFromBrief).toEqual(['None.']);
    expect(r.unresolved).toEqual(['None.']);
  });

  it('handles missing optional sections', () => {
    const r = parseStructuredReport('## Summary\nDone.\n\n## Unresolved\nItem 1.');
    expect(r.summary).toBe('Done.');
    expect(r.unresolved).toEqual(['Item 1.']);
  });

  it('returns null fields for empty/missing sections', () => {
    const r = parseStructuredReport('');
    expect(r.summary).toBeNull();
    expect(r.filesChanged).toEqual([]);
  });
});
