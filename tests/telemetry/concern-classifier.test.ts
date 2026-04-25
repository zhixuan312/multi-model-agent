import { describe, it, expect } from 'vitest';
import { classifyConcern } from '../../packages/core/src/telemetry/concern-classifier.js';

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
