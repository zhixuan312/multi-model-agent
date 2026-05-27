import { describe, it, expect } from 'bun:test';
import { parseInvestigationReport } from '../../packages/core/src/reporting/report-parser-slots/investigate-report.js';

describe('investigate: evidence (none) cross-section enforcement', () => {
  it('keeps Finding with Evidence: (none) when Confidence is low', () => {
    const out = `## Finding 1: No evidence available
- Evidence: (none)

## Summary
Searched broadly but found no references.

## Confidence
low — search conducted in all known locations
`;
    const r = parseInvestigationReport(out);
    expect(r.kind).toBe('structured_report');
    if (r.kind !== 'structured_report') return;
    // Finding with (none) evidence should be kept when confidence is low
    expect(r.investigation.findings).toHaveLength(1);
    expect(r.investigation.findings[0]?.evidenceIsNone).toBe(true);
  });

  it('drops Finding with Evidence: (none) when Confidence is high', () => {
    const out = `## Finding 1: No evidence available
- Evidence: (none)

## Summary
Found everything needed.

## Confidence
high — comprehensive analysis completed
`;
    const r = parseInvestigationReport(out);
    expect(r.kind).toBe('structured_report');
    if (r.kind !== 'structured_report') return;
    // Finding with (none) evidence should be dropped when confidence is high
    expect(r.investigation.findings).toHaveLength(0);
  });

  it('drops Finding with Evidence: (none) when Confidence is medium', () => {
    const out = `## Finding 1: No evidence available
- Evidence: (none)

## Summary
Partial results found.

## Confidence
medium — some gaps remain
`;
    const r = parseInvestigationReport(out);
    expect(r.kind).toBe('structured_report');
    if (r.kind !== 'structured_report') return;
    // Finding with (none) evidence should be dropped when confidence is medium
    expect(r.investigation.findings).toHaveLength(0);
  });

  it('keeps Findings with actual Evidence regardless of Confidence level', () => {
    const out = `## Finding 1: Found reference
- Evidence: src/auth.ts:42-50 — handles token refresh

## Finding 2: No evidence available
- Evidence: (none)

## Summary
Mixed results.

## Confidence
high — found key references
`;
    const r = parseInvestigationReport(out);
    expect(r.kind).toBe('structured_report');
    if (r.kind !== 'structured_report') return;
    // Both findings should be kept: first has evidence, second is dropped because confidence is high
    expect(r.investigation.findings).toHaveLength(1);
    expect(r.investigation.findings[0]?.evidenceIsNone).toBe(false);
  });

  it('extracts citations from Evidence bullets in Findings', () => {
    const out = `## Finding 1: Refresh mechanism
- Evidence: src/auth/refresh.ts:45-72 — Refresh handler reads bearer.

## Finding 2: Token storage
- Evidence: src/storage.ts:10 — Token stored in cache

## Summary
Multiple references found.

## Confidence
high — all citations verified
`;
    const r = parseInvestigationReport(out);
    expect(r.kind).toBe('structured_report');
    if (r.kind !== 'structured_report') return;
    expect(r.investigation.citations).toEqual([
      { file: 'src/auth/refresh.ts', lines: '45-72', claim: 'Refresh handler reads bearer.' },
      { file: 'src/storage.ts', lines: '10', claim: 'Token stored in cache' },
    ]);
  });
});
