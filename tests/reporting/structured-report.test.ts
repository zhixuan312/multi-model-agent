import { describe, it, expect } from 'vitest';
import { structuredReportSuffix, parseStructuredReport } from '@zhixuan92/multi-model-agent-core/reporting/structured-report';

describe('structuredReportSuffix', () => {
  it('contains all required section headers', () => {
    const s = structuredReportSuffix;
    expect(s).toContain('## Summary');
    expect(s).toContain('## Files changed');
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

  it('parses # Summary (h1 instead of h2)', () => {
    const report = parseStructuredReport('# Summary\nApproved. All good.\n\n## Files changed\n- foo.ts: added');
    expect(report.summary).toBe('Approved. All good.');
  });

  it('parses **Summary** (bold instead of heading)', () => {
    const report = parseStructuredReport('**Summary**\nchanges_required. Fix the bug.\n\n**Files changed**\n- bar.ts: fixed');
    expect(report.summary).toBe('changes_required. Fix the bug.');
  });

  it('parses Summary: (colon suffix)', () => {
    const report = parseStructuredReport('Summary: Approved with no issues.\n\nFiles changed:\n- baz.ts: updated');
    expect(report.summary).toBe('Approved with no issues.');
  });

  it('treats first paragraph as implicit summary when no heading found', () => {
    const report = parseStructuredReport('Approved. The implementation looks correct and matches the spec.\n\nSome additional notes here.');
    expect(report.summary).toBe('Approved. The implementation looks correct and matches the spec.');
  });
});
