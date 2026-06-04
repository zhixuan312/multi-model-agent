import { describe, it, expect } from 'vitest';
import {
  normalizeSeverity,
  countHighOrCritical,
  bucketFindingsBySeverity,
} from '../../packages/core/src/reporting/severity.js';

describe('severity helpers (4.0.3+ Gap 2)', () => {
  describe('normalizeSeverity', () => {
    it('passes through canonical values', () => {
      expect(normalizeSeverity('critical')).toBe('critical');
      expect(normalizeSeverity('high')).toBe('high');
      expect(normalizeSeverity('medium')).toBe('medium');
      expect(normalizeSeverity('low')).toBe('low');
    });

    it('lowercases mixed-case values', () => {
      expect(normalizeSeverity('CRITICAL')).toBe('critical');
      expect(normalizeSeverity('High')).toBe('high');
      expect(normalizeSeverity('  Medium  ')).toBe('medium');
    });

    it('returns null for unknown values', () => {
      expect(normalizeSeverity('blocker')).toBeNull();
      expect(normalizeSeverity('')).toBeNull();
      expect(normalizeSeverity(undefined)).toBeNull();
      expect(normalizeSeverity(42)).toBeNull();
    });
  });

  describe('countHighOrCritical', () => {
    it('counts high AND critical as one aggregate', () => {
      const findings = [
        { severity: 'critical' },
        { severity: 'high' },
        { severity: 'medium' },
        { severity: 'low' },
      ];
      expect(countHighOrCritical(findings)).toBe(2);
    });

    it('is case-insensitive', () => {
      const findings = [{ severity: 'CRITICAL' }, { severity: 'High' }, { severity: 'low' }];
      expect(countHighOrCritical(findings)).toBe(2);
    });

    it('ignores unknown severities (does not count them as high)', () => {
      const findings = [{ severity: 'blocker' }, { severity: 'major' }, { severity: 'high' }];
      expect(countHighOrCritical(findings)).toBe(1);
    });

    it('returns 0 for empty array', () => {
      expect(countHighOrCritical([])).toBe(0);
    });
  });

  describe('bucketFindingsBySeverity', () => {
    it('keeps critical and high as SEPARATE buckets (Gap 2 round-2 F1)', () => {
      const findings = [
        { severity: 'critical' },
        { severity: 'critical' },
        { severity: 'high' },
        { severity: 'medium' },
        { severity: 'low' },
        { severity: 'low' },
      ];
      const buckets = bucketFindingsBySeverity(findings);
      expect(buckets).toEqual({ critical: 2, high: 1, medium: 1, low: 2 });
    });

    it('drops unknown severities silently (does not bucket as medium)', () => {
      const findings = [{ severity: 'blocker' }, { severity: 'high' }];
      const buckets = bucketFindingsBySeverity(findings);
      expect(buckets).toEqual({ critical: 0, high: 1, medium: 0, low: 0 });
    });

    it('returns zeros for empty array', () => {
      expect(bucketFindingsBySeverity([])).toEqual({ critical: 0, high: 0, medium: 0, low: 0 });
    });

    it('case-insensitive', () => {
      const findings = [{ severity: 'CRITICAL' }, { severity: 'HIGH' }, { severity: 'Low' }];
      const buckets = bucketFindingsBySeverity(findings);
      expect(buckets).toEqual({ critical: 1, high: 1, medium: 0, low: 1 });
    });
  });

  // 4.0.3+ Gap 16 — narrative-findings fallback when annotator errors.
  describe('parseNarrativeFindings', () => {
    it('extracts each ## Finding N: block with its severity', async () => {
      const { parseNarrativeFindings } = await import(
        '../../packages/core/src/reporting/severity.js'
      );
      const out = `Some preamble.

## Finding 1: First problem
- Severity: high
- Issue: A real bug.

## Finding 2: Second problem
- Severity: medium
- Issue: Smaller issue.

## Finding 3: Third
- Severity: low
- Suggestion: minor.
`;
      const findings = parseNarrativeFindings(out);
      expect(findings).toHaveLength(3);
      expect(findings[0]).toEqual({ severity: 'high', claim: 'First problem' });
      expect(findings[1]).toEqual({ severity: 'medium', claim: 'Second problem' });
      expect(findings[2]).toEqual({ severity: 'low', claim: 'Third' });
    });

    it('returns empty array when no Finding blocks are present', async () => {
      const { parseNarrativeFindings } = await import(
        '../../packages/core/src/reporting/severity.js'
      );
      expect(parseNarrativeFindings('No findings here, just prose.')).toEqual([]);
      expect(parseNarrativeFindings('')).toEqual([]);
      expect(parseNarrativeFindings(undefined as unknown as string)).toEqual([]);
    });

    it('records null severity when the severity line is missing', async () => {
      const { parseNarrativeFindings } = await import(
        '../../packages/core/src/reporting/severity.js'
      );
      const out = `## Finding 1: untyped
- Issue: no severity here.
`;
      const findings = parseNarrativeFindings(out);
      expect(findings).toHaveLength(1);
      expect(findings[0]).toEqual({ severity: null, claim: 'untyped' });
    });

    it('handles case-insensitive Finding heading', async () => {
      const { parseNarrativeFindings } = await import(
        '../../packages/core/src/reporting/severity.js'
      );
      const out = `## finding 1: lowercase heading
- severity: critical
`;
      expect(parseNarrativeFindings(out)).toEqual([
        { severity: 'critical', claim: 'lowercase heading' },
      ]);
    });

    it('integrates with countHighOrCritical for headline counting', async () => {
      const { parseNarrativeFindings } = await import(
        '../../packages/core/src/reporting/severity.js'
      );
      const out = `## Finding 1: A
- Severity: critical

## Finding 2: B
- Severity: high

## Finding 3: C
- Severity: low
`;
      const findings = parseNarrativeFindings(out);
      expect(countHighOrCritical(findings)).toBe(2);
    });
  });
});
