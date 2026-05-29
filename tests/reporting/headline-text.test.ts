import { describe, it, expect } from 'bun:test';
import { firstSentenceOrTruncate } from '../../packages/core/src/reporting/headline-text.js';

describe('firstSentenceOrTruncate (Gap 12)', () => {
  it('returns the first sentence when one exists', () => {
    expect(firstSentenceOrTruncate('Done. The rest is detail.')).toBe('Done.');
    expect(firstSentenceOrTruncate('Edit applied successfully! Then more.')).toBe('Edit applied successfully!');
  });

  it('handles ? as sentence end', () => {
    expect(firstSentenceOrTruncate('Was it OK? Probably yes.')).toBe('Was it OK?');
  });

  it('handles a single sentence with no terminator', () => {
    // No period AND short enough → return as-is.
    expect(firstSentenceOrTruncate('one short line no terminator')).toBe('one short line no terminator');
  });

  it('truncates with ellipsis when no sentence boundary in first 80 chars', () => {
    const long = 'a'.repeat(120);
    const out = firstSentenceOrTruncate(long, 80);
    expect(out.length).toBe(80);
    expect(out.endsWith('…')).toBe(true);
  });

  it('does not truncate text shorter than max even without sentence break', () => {
    expect(firstSentenceOrTruncate('short blurb', 80)).toBe('short blurb');
  });

  it('handles the Gap 12 reproduction case (mid-sentence colon)', () => {
    // The worker's actual emission from telemetry id 854741.
    const raw = 'The edit has been applied successfully. The file-level JSDoc comment in `packages/core/src/lifecycle/stage-progression.ts` now ends with:';
    const out = firstSentenceOrTruncate(raw);
    expect(out).toBe('The edit has been applied successfully.');
  });

  it('returns empty string for empty / whitespace / non-string input', () => {
    expect(firstSentenceOrTruncate('')).toBe('');
    expect(firstSentenceOrTruncate('   ')).toBe('');
    expect(firstSentenceOrTruncate(null as unknown as string)).toBe('');
    expect(firstSentenceOrTruncate(undefined as unknown as string)).toBe('');
  });

  it('trims leading/trailing whitespace before processing', () => {
    expect(firstSentenceOrTruncate('  Hello.  Bye.  ')).toBe('Hello.');
  });

  // 4.0.3 audit findings (telemetry id 854913):
  //
  // F1: regex must allow internal `.!?` (version numbers, decimals,
  //     filenames) — only break on a `.!?` followed by whitespace OR EOL.
  // F2: `max` parameter MUST scope the search range, not just the
  //     truncation fallback. Hardcoded 80 ignored callers' overrides.
  it('handles internal version-number periods (v4.0.3) without falling through', () => {
    expect(firstSentenceOrTruncate('Fixed v4.0.3 regression. Details follow.'))
      .toBe('Fixed v4.0.3 regression.');
  });

  it('handles internal decimal numbers (1.5) without falling through', () => {
    expect(firstSentenceOrTruncate('Raised threshold to 1.5. Additional context.'))
      .toBe('Raised threshold to 1.5.');
  });

  it('handles internal filenames (auth.ts) without falling through', () => {
    expect(firstSentenceOrTruncate('Updated auth.ts. More details.'))
      .toBe('Updated auth.ts.');
  });

  it('respects a custom max parameter for sentence-search range', () => {
    // 100-char first sentence — without max=120, falls through to truncate at 80.
    const longFirst = 'A'.repeat(100) + '.';
    const followup = ' Then more.';
    const out = firstSentenceOrTruncate(longFirst + followup, 120);
    expect(out).toBe(longFirst); // full first sentence, since 101 ≤ 120
  });

  it('default max=80 still finds sentences ≤80 chars', () => {
    const text = 'A'.repeat(70) + '. Then more.';
    expect(firstSentenceOrTruncate(text)).toBe('A'.repeat(70) + '.');
  });

  // Follow-up audit findings (run id ff925105):
  // F1: truncated output must stay single-line (collapse \n to space).
  // F2: invalid `max` (NaN, Infinity, ≤0) must not throw or overrun.
  it('F1: collapses embedded newlines (single-line headline contract)', () => {
    const multiline = 'A long line goes here\nand then another newline\nand a third';
    const out = firstSentenceOrTruncate(multiline, 200);
    expect(out).not.toContain('\n');
    expect(out).toBe('A long line goes here and then another newline and a third');
  });

  it('F1: collapses tabs + CRs', () => {
    expect(firstSentenceOrTruncate('foo\tbar\r\nbaz', 200)).toBe('foo bar baz');
  });

  it('F1: collapses newlines AND truncates', () => {
    const messy = 'A'.repeat(50) + '\n' + 'B'.repeat(50);
    const out = firstSentenceOrTruncate(messy, 30);
    expect(out).not.toContain('\n');
    expect(out.length).toBe(30);
    expect(out.endsWith('…')).toBe(true);
  });

  it('F2: max=0 falls back to 80', () => {
    expect(firstSentenceOrTruncate('Hello.', 0)).toBe('Hello.');
  });

  it('F2: negative max falls back to 80', () => {
    expect(firstSentenceOrTruncate('Hello.', -5)).toBe('Hello.');
  });

  it('F2: NaN / non-finite max falls back to 80', () => {
    expect(firstSentenceOrTruncate('Hello.', NaN)).toBe('Hello.');
    expect(firstSentenceOrTruncate('Hello.', Infinity)).toBe('Hello.');
    expect(firstSentenceOrTruncate('Hello.', -Infinity)).toBe('Hello.');
  });

  it('F2: caps max at 2000 to avoid unbounded regex backtracking', () => {
    const text = 'A'.repeat(2500) + '.';
    const out = firstSentenceOrTruncate(text, 1_000_000_000);
    expect(out.length).toBe(2000);
  });

  // audit-2 follow-up (run id 2909e5d2):
  // N1: captured sentence must be ≤ safeMax (was safeMax+1).
  // N2: sentences wrapping across a newline must still be detected.
  it('N1: captured sentence never exceeds max (off-by-one fix)', () => {
    // "Hello." is 6 chars; with max=5 the sentence does NOT fit, so we
    // hard-truncate instead of returning the over-budget sentence.
    expect(firstSentenceOrTruncate('Hello. Details', 5)).toBe('Hell…');
  });

  it('N1: sentence exactly equal to max still matches', () => {
    // "Hello." is 6 chars; with max=6 it should match exactly.
    expect(firstSentenceOrTruncate('Hello. Details', 6)).toBe('Hello.');
  });

  it('N1: max=1 leaves no room for "X." → falls through to truncate', () => {
    expect(firstSentenceOrTruncate('Hello.', 1)).toBe('…');
  });

  it('N2: detects sentence that wraps across a newline before punctuation', () => {
    expect(firstSentenceOrTruncate('Fixed auth\nissue. More details')).toBe(
      'Fixed auth issue.',
    );
  });

  it('N2: extracts first sentence cleanly when newline follows punctuation', () => {
    expect(firstSentenceOrTruncate('First sentence.\nSecond sentence.')).toBe(
      'First sentence.',
    );
  });
});
