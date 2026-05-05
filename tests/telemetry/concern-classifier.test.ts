import { describe, it, expect } from 'vitest';
import { classifyConcern } from '../../packages/core/src/events/concern-classifier.js';

const AUDIT_FIXTURES = [
  { message: 'PRQ-001 appears stale because the provider override is now wired through the core provider factory while the queue still documents it as dead.', expectedNot: 'other' },
  { message: 'Some endpoint contract tests may still encode the obsolete assumption that the mock provider override is not wired through run-tasks.', expectedNot: 'other' },
  { message: 'PRQ-002 is only superficially resolved because the skipped clarification-confirmation contract test was removed without replacement coverage.', expectedNot: 'other' },
  { message: 'PRQ-004 remains substantively unfixed because the skipped lifecycle clarification-precedence test was removed without an active replacement.', expectedNot: 'other' },
  { message: 'The delegate clarification path allegedly returns clarification metadata but leaves the main 7-field envelope\'s proposedInterpretation as not_applicable.', expectedNot: 'other' },
  { message: 'The server-side test-provider override appears to be a stale or unused seam now that the working path is the core-level override.', expectedNot: 'other' },
  { message: 'PRQ-003 is a historical non-actionable item that should not remain in an active release bug queue.', expectedNot: 'other' },
];

const GOLDEN: Array<[input: { source: string; severity: string; message: string }, expected: string]> = [
  [{ source: 'spec_review', severity: 'major', message: 'no test for the new branch' }, 'missing_test'],
  [{ source: 'spec_review', severity: 'minor', message: 'unrelated refactor included' }, 'scope_creep'],
  [{ source: 'quality_review', severity: 'major', message: 'TODO: implement error case' }, 'incomplete_impl'],
  [{ source: 'quality_review', severity: 'minor', message: 'use camelCase here' }, 'style_lint'],
  [{ source: 'quality_review', severity: 'critical', message: 'sql injection in user input' }, 'security'],
  [{ source: 'quality_review', severity: 'major', message: 'O(n^2) loop on hot path' }, 'performance'],
  [{ source: 'quality_review', severity: 'minor', message: 'consider extracting helper' }, 'maintainability'],
  [{ source: 'spec_review', severity: 'minor', message: 'README not updated' }, 'doc_gap'],
  [{ source: 'quality_review', severity: 'minor', message: 'something completely surprising' }, 'other'],

  // Negative goldens — must NOT trigger an over-eager pattern.
  [{ source: 'quality_review', severity: 'minor', message: 'there is no known issue here' }, 'other'],         // not 'missing_test' (precedence guard)
  [{ source: 'quality_review', severity: 'minor', message: 'lifestyle of the codebase' }, 'other'],            // word-boundary `\bstyle\b` correctly excludes substrings of 'lifestyle' — guard against future removal of `\b`
  [{ source: 'spec_review',    severity: 'minor', message: 'documenting that we accepted this scope' }, 'doc_gap'], // 'docs' wins legitimately
];

describe('concern-classifier', () => {
  for (const [input, expected] of GOLDEN) {
    it(`maps "${input.message}" → ${expected}`, () => {
      expect(classifyConcern(input)).toBe(expected);
    });
  }

  it('never reads back the raw message past classification', () => {
    const out = classifyConcern({ source: 'spec_review', severity: 'major', message: 'super secret path /Users/x/y' });
    // The output is a single enum string, not an object — no message can leak.
    expect(typeof out).toBe('string');
  });
});

describe('concern classifier (audit-domain extension)', () => {
  it('produces ≥3 distinct non-other categories from the round-1 fixtures', () => {
    const cats = new Set(AUDIT_FIXTURES.map(f => classifyConcern({ source: 'quality_review', severity: 'medium', message: f.message })));
    cats.delete('other');
    expect(cats.size).toBeGreaterThanOrEqual(3);
  });

  for (const fixture of AUDIT_FIXTURES) {
    it(`classifies "${fixture.message.slice(0, 60)}…" as not 'other'`, () => {
      const cat = classifyConcern({ source: 'quality_review', severity: 'medium', message: fixture.message });
      expect(cat).not.toBe('other');
    });
  }

  it('source-code review patterns still classify correctly', () => {
    expect(classifyConcern({ source: 'spec_review', severity: 'medium', message: 'missing unit tests for X' })).toBe('missing_test');
    expect(classifyConcern({ source: 'diff_review', severity: 'critical', message: 'sql injection in handler' })).toBe('security');
  });
});
