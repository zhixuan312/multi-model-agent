import { describe, it, expect } from 'vitest';
import { structuredReportSuffix, parseStructuredReport, commitSchema } from '@zhixuan92/multi-model-agent-core/reporting/structured-report';

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

describe('structured-report commit field', () => {
  const validCommit = { type: 'feat' as const, scope: 'core', subject: 'add x', body: 'why' };

  it('accepts valid commit block', () => {
    const r = parseStructuredReport(`## Summary\nDone.\n\ncommit:\n${JSON.stringify(validCommit)}\n`);
    expect(r.commit).toEqual(validCommit);
  });

  it('rejects subject > 50 chars', () => {
    const bad = { ...validCommit, subject: 'x'.repeat(51) };
    expect(() => commitSchema.parse(bad)).toThrow(/50/);
  });

  it('rejects subject starting with ASCII uppercase', () => {
    expect(() => commitSchema.parse({ ...validCommit, subject: 'Add x' })).toThrow();
  });

  it('rejects subject with trailing colon', () => {
    expect(() => commitSchema.parse({ ...validCommit, subject: 'add x:' })).toThrow();
  });

  it('rejects subject with leading or trailing whitespace (no silent trim)', () => {
    expect(() => commitSchema.parse({ ...validCommit, subject: ' add x' })).toThrow();
    expect(() => commitSchema.parse({ ...validCommit, subject: 'add x ' })).toThrow();
  });

  it('rejects scope with invalid first char', () => {
    expect(() => commitSchema.parse({ ...validCommit, scope: '/bad' })).toThrow();
  });

  it('accepts scope "server/http", "run_tasks", "api.v2"', () => {
    expect(commitSchema.parse({ ...validCommit, scope: 'server/http' })).toBeDefined();
    expect(commitSchema.parse({ ...validCommit, scope: 'run_tasks' })).toBeDefined();
    expect(commitSchema.parse({ ...validCommit, scope: 'api.v2' })).toBeDefined();
  });

  it('rejects unknown type enum', () => {
    expect(() => commitSchema.parse({ ...validCommit, type: 'wip' as any })).toThrow();
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

describe('(none) literal handling', () => {
  it('parseStructuredReport returns empty filesChanged when section body is "(none)"', () => {
    const r = parseStructuredReport('## Summary\nx\n## Files changed\n(none)\n');
    expect(r.filesChanged).toEqual([]);
  });

  it('parseStructuredReport returns empty filesChanged when section body is "none"', () => {
    const r = parseStructuredReport('## Summary\nx\n## Files changed\nnone\n');
    expect(r.filesChanged).toEqual([]);
  });

  it('parseStructuredReport returns empty filesChanged for case-insensitive "N/A" with bullet', () => {
    const r = parseStructuredReport('## Summary\nx\n## Files changed\n- n/a\n');
    expect(r.filesChanged).toEqual([]);
  });

  it('parseStructuredReport returns empty validationsRun when body is "(none)"', () => {
    const r = parseStructuredReport('## Summary\nx\n## Validations run\n(none)\n');
    expect(r.validationsRun).toEqual([]);
  });

  it('does not collapse non-(none) entries that happen to contain the word', () => {
    const r = parseStructuredReport('## Summary\nx\n## Files changed\n- src/none-handler.ts: tweak\n');
    expect(r.filesChanged).toEqual([{ path: 'src/none-handler.ts', summary: 'tweak' }]);
  });
});
