import { describe, it, expect } from 'vitest';
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
});
