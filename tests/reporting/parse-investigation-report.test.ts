// tests/reporting/parse-investigation-report.test.ts
import { parseCitations } from '../../packages/core/src/reporting/parse-investigation-report.js';

describe('parseCitations', () => {
  it('parses a simple bulleted citation with em-dash', () => {
    const r = parseCitations(['- src/auth/refresh.ts:45-72 — Refresh handler reads bearer.']);
    expect(r.citations).toEqual([{ file: 'src/auth/refresh.ts', lines: '45-72', claim: 'Refresh handler reads bearer.' }]);
    expect(r.malformedCitationLines).toBe(0);
  });

  it('parses asterisk bullets and double-dash separator', () => {
    const r = parseCitations(['* src/a.ts:1 -- claim text']);
    expect(r.citations).toEqual([{ file: 'src/a.ts', lines: '1', claim: 'claim text' }]);
  });

  it('parses no-bullet lines', () => {
    const r = parseCitations(['src/a.ts:1 — claim']);
    expect(r.citations.length).toBe(1);
  });

  it('parses numbered list bullets (1. and 1))', () => {
    const r = parseCitations(['1. src/a.ts:12 — claim a', '2) src/b.ts:13-15 -- claim b']);
    expect(r.citations.length).toBe(2);
  });

  it('handles paths containing colons (POSIX)', () => {
    const r = parseCitations(['src/foo:bar/file.ts:45 — claim']);
    expect(r.citations).toEqual([{ file: 'src/foo:bar/file.ts', lines: '45', claim: 'claim' }]);
  });

  it('handles Windows-style absolute paths', () => {
    const r = parseCitations(['C:\\repo\\src\\file.ts:45 — handles refresh']);
    expect(r.citations).toEqual([{ file: 'C:\\repo\\src\\file.ts', lines: '45', claim: 'handles refresh' }]);
  });

  it('rejects leading-zero line tokens', () => {
    const r = parseCitations(['- src/a.ts:001 — claim', '- src/b.ts:1-01 — claim']);
    expect(r.citations).toEqual([]);
    expect(r.malformedCitationLines).toBe(2);
  });

  it('rejects zero, negatives, and reversed ranges', () => {
    const r = parseCitations(['- src/a.ts:0 — c', '- src/b.ts:0-10 — c', '- src/c.ts:-5 — c', '- src/d.ts:20-10 — c']);
    expect(r.citations).toEqual([]);
    expect(r.malformedCitationLines).toBe(4);
  });

  it('rejects line tokens beyond MAX_SAFE_INTEGER', () => {
    const r = parseCitations(['- src/a.ts:99999999999999999999 — claim']);
    expect(r.citations).toEqual([]);
    expect(r.malformedCitationLines).toBe(1);
  });

  it('preserves the original lines token verbatim', () => {
    const r = parseCitations(['- src/a.ts:45-72 — c', '- src/b.ts:45 — c']);
    expect(r.citations.map(c => c.lines)).toEqual(['45-72', '45']);
  });

  it('rejects empty claims', () => {
    const r = parseCitations(['- src/a.ts:1 — ']);
    expect(r.citations).toEqual([]);
    expect(r.malformedCitationLines).toBe(1);
  });

  it('skips blank lines without counting them as malformed', () => {
    const r = parseCitations(['', '   ', '- src/a.ts:1 — c']);
    expect(r.citations.length).toBe(1);
    expect(r.malformedCitationLines).toBe(0);
  });
});
import { parseConfidence } from '../../packages/core/src/reporting/parse-investigation-report.js';

describe('parseConfidence', () => {
  it('parses "high — rationale"', () => {
    expect(parseConfidence(['high — all citations verified'])).toEqual({ level: 'high', rationale: 'all citations verified' });
  });

  it('parses "medium -- rationale"', () => {
    expect(parseConfidence(['medium -- partial coverage'])).toEqual({ level: 'medium', rationale: 'partial coverage' });
  });

  it('parses "low: rationale"', () => {
    expect(parseConfidence(['low: no test coverage found'])).toEqual({ level: 'low', rationale: 'no test coverage found' });
  });

  it('parses bare level token (no separator)', () => {
    expect(parseConfidence(['high'])).toEqual({ level: 'high', rationale: '' });
  });

  it('is case-insensitive on the level token but normalizes to lowercase', () => {
    expect(parseConfidence(['HIGH — x'])).toEqual({ level: 'high', rationale: 'x' });
  });

  it('appends subsequent non-blank lines to the rationale separated by newline', () => {
    expect(parseConfidence(['high — first', 'second line', '', 'third line'])).toEqual({ level: 'high', rationale: 'first\nsecond line\nthird line' });
  });

  it('returns null for an unparseable level token', () => {
    expect(parseConfidence(['maybe?'])).toBeNull();
    expect(parseConfidence(['highly confident'])).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(parseConfidence([])).toBeNull();
    expect(parseConfidence([''])).toBeNull();
  });

  it('rejects "high confidence" (no separator)', () => {
    expect(parseConfidence(['high confidence'])).toBeNull();
  });

  it('rejects "high—because" (em-dash without surrounding spaces)', () => {
    expect(parseConfidence(['high—because'])).toBeNull();
  });

  it('rejects "high--because" (dash without surrounding spaces)', () => {
    expect(parseConfidence(['high--because'])).toBeNull();
  });
});

import { parseInvestigationReport } from '../../packages/core/src/reporting/parse-investigation-report.js';

describe('parseInvestigationReport — discriminated union and sectionValidity', () => {
  it('kind=no_structured_report when output is empty', () => {
    expect(parseInvestigationReport('').kind).toBe('no_structured_report');
    expect(parseInvestigationReport('   ').kind).toBe('no_structured_report');
  });

  it('kind=no_structured_report when output has no parseable sections', () => {
    expect(parseInvestigationReport('I refused this request.').kind).toBe('no_structured_report');
  });

  it('kind=structured_report with all valid sections', () => {
    const out = `## Summary\nThe answer.\n## Citations\n- src/a.ts:1 — claim\n## Confidence\nhigh — all verified\n`;
    const r = parseInvestigationReport(out);
    expect(r.kind).toBe('structured_report');
    if (r.kind !== 'structured_report') return;
    expect(r.sectionValidity).toEqual({ summary: 'valid', citations: 'valid', confidence: 'valid' });
    expect(r.investigation.citations.length).toBe(1);
    expect(r.investigation.confidence?.level).toBe('high');
    expect(r.investigation.diagnostics).toEqual({
      malformedCitationLines: 0,
      missingRequiredSections: [],
      invalidRequiredSections: [],
    });
  });

  it('citations empty_legitimate when (none) + low confidence', () => {
    const out = `## Summary\nNo evidence found.\n## Citations\n(none)\n## Confidence\nlow — searched broadly\n`;
    const r = parseInvestigationReport(out);
    if (r.kind !== 'structured_report') throw new Error('expected structured');
    expect(r.sectionValidity.citations).toBe('empty_legitimate');
    expect(r.investigation.diagnostics.invalidRequiredSections).toEqual([]);
  });

  it('citations empty_invalid when (none) but confidence not low', () => {
    const out = `## Summary\nx\n## Citations\n(none)\n## Confidence\nhigh — x\n`;
    const r = parseInvestigationReport(out);
    if (r.kind !== 'structured_report') throw new Error('expected structured');
    expect(r.sectionValidity.citations).toBe('empty_invalid');
    expect(r.investigation.diagnostics.invalidRequiredSections).toContain('citations');
  });

  it('citations empty_invalid when all lines malformed', () => {
    const out = `## Summary\nx\n## Citations\n- not a citation\n- src/a.ts:abc — c\n## Confidence\nhigh — x\n`;
    const r = parseInvestigationReport(out);
    if (r.kind !== 'structured_report') throw new Error('expected structured');
    expect(r.sectionValidity.citations).toBe('empty_invalid');
    expect(r.investigation.diagnostics.malformedCitationLines).toBe(2);
    expect(r.investigation.diagnostics.invalidRequiredSections).toContain('citations');
  });

  it('citations missing → diagnostics.missingRequiredSections includes citations', () => {
    const out = `## Summary\nx\n## Confidence\nhigh — x\n`;
    const r = parseInvestigationReport(out);
    if (r.kind !== 'structured_report') throw new Error('expected structured');
    expect(r.sectionValidity.citations).toBe('missing');
    expect(r.investigation.diagnostics.missingRequiredSections).toContain('citations');
    expect(r.investigation.diagnostics.invalidRequiredSections).not.toContain('citations');
  });

  it('confidence missing vs invalid are disjoint', () => {
    const missing = parseInvestigationReport('## Summary\nx\n## Citations\n- a:1 — c\n');
    const invalid = parseInvestigationReport('## Summary\nx\n## Citations\n- a:1 — c\n## Confidence\nmaybe?\n');
    if (missing.kind !== 'structured_report' || invalid.kind !== 'structured_report') throw new Error();
    expect(missing.investigation.diagnostics.missingRequiredSections).toContain('confidence');
    expect(missing.investigation.diagnostics.invalidRequiredSections).not.toContain('confidence');
    expect(invalid.investigation.diagnostics.invalidRequiredSections).toContain('confidence');
    expect(invalid.investigation.diagnostics.missingRequiredSections).not.toContain('confidence');
  });

  it('summary empty (whitespace body) → invalidRequiredSections includes summary', () => {
    const out = `## Summary\n   \n## Citations\n- a:1 — c\n## Confidence\nhigh — x\n`;
    const r = parseInvestigationReport(out);
    if (r.kind !== 'structured_report') throw new Error();
    expect(r.sectionValidity.summary).toBe('empty');
    expect(r.investigation.diagnostics.invalidRequiredSections).toContain('summary');
  });

  it('summary missing → missingRequiredSections includes summary', () => {
    const out = `## Citations\n- a:1 — c\n## Confidence\nhigh — x\n`;
    const r = parseInvestigationReport(out);
    if (r.kind !== 'structured_report') throw new Error();
    expect(r.sectionValidity.summary).toBe('missing');
    expect(r.investigation.diagnostics.missingRequiredSections).toContain('summary');
  });

  it('arrays are in deterministic section order: summary, citations, confidence', () => {
    const out = `## Citations\n## Confidence\nmaybe?\n`;
    const r = parseInvestigationReport(out);
    if (r.kind !== 'structured_report') throw new Error();
    expect(r.investigation.diagnostics.missingRequiredSections).toEqual(['summary']);
    expect(r.investigation.diagnostics.invalidRequiredSections).toEqual(['citations', 'confidence']);
  });
});

describe('parseInvestigationReport — additional contracts', () => {
  it('arbitrary unrelated header (e.g. ## Notes) → no_structured_report', () => {
    const r = parseInvestigationReport('## Notes\nI cannot help.\n');
    expect(r.kind).toBe('no_structured_report');
  });

  it('detects [needs_context] marker in ## Unresolved bullets (case-insensitive)', () => {
    const out = `## Summary\nx\n## Citations\n- a:1 — c\n## Confidence\nhigh — x\n## Unresolved\n- [needs_context] please clarify auth flow\n`;
    const r = parseInvestigationReport(out);
    if (r.kind !== 'structured_report') throw new Error();
    expect(r.investigation.needsCallerClarification).toBe(true);
  });

  it('does NOT treat plain prose "I need clarification" as needs_context', () => {
    const out = `## Summary\nx\n## Citations\n- a:1 — c\n## Confidence\nhigh — x\n## Unresolved\n- I need clarification\n`;
    const r = parseInvestigationReport(out);
    if (r.kind !== 'structured_report') throw new Error();
    expect(r.investigation.needsCallerClarification).toBe(false);
  });

  it('mixed citations body: (none) alongside a parseable citation → (none) counted as malformed', () => {
    const out = `## Summary\nx\n## Citations\n(none)\n- src/a.ts:10 — claim\n## Confidence\nlow — x\n`;
    const r = parseInvestigationReport(out);
    if (r.kind !== 'structured_report') throw new Error();
    expect(r.sectionValidity.citations).toBe('valid');
    expect(r.investigation.citations.length).toBe(1);
    expect(r.investigation.diagnostics.malformedCitationLines).toBe(1);
  });
});
