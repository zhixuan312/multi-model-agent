import { describe, it, expect } from 'vitest';
import { trySkipAnnotatorOnZeroFindings } from '../../../packages/core/src/lifecycle/handlers/quality-chain-handlers.js';

// Tool sweep #11: short-circuit the annotator call when the read-only
// worker emitted ZERO findings + a short "no issues" narrative. This
// pins the heuristic so a future loosening can't slip in.

const isReadOnly = false; // arg is `isArtifactProducing`; false = read-only

describe('trySkipAnnotatorOnZeroFindings (tool sweep #11)', () => {
  it('returns null on artifact-producing routes (always reviews)', () => {
    expect(
      trySkipAnnotatorOnZeroFindings('No findings.', /* isArtifactProducing */ true),
    ).toBeNull();
  });

  it('returns null on missing / empty / non-string output', () => {
    expect(trySkipAnnotatorOnZeroFindings(undefined, isReadOnly)).toBeNull();
    expect(trySkipAnnotatorOnZeroFindings('', isReadOnly)).toBeNull();
    expect(trySkipAnnotatorOnZeroFindings('   \n\n  ', isReadOnly)).toBeNull();
  });

  it('returns null when narrative contains a `## Finding N:` heading', () => {
    const out = `## Finding 1: thing\n- Severity: low\n- Issue: a real bug.`;
    expect(trySkipAnnotatorOnZeroFindings(out, isReadOnly)).toBeNull();
  });

  it('returns null when narrative is long (>400 chars), even without findings', () => {
    const long = 'a'.repeat(401);
    expect(trySkipAnnotatorOnZeroFindings(long, isReadOnly)).toBeNull();
  });

  it('returns null without an explicit no-issues marker', () => {
    const out = 'I looked at the code. It seems fine, I think.';
    expect(trySkipAnnotatorOnZeroFindings(out, isReadOnly)).toBeNull();
  });

  it('SHORT-CIRCUITS on "No findings."', () => {
    const r = trySkipAnnotatorOnZeroFindings('No findings.', isReadOnly);
    expect(r).not.toBeNull();
    expect(r?.verdict).toBe('approved');
    expect(r?.annotatedFindings).toEqual([]);
    expect(r?.concerns).toEqual([]);
  });

  it('SHORT-CIRCUITS on "No issues identified in the file."', () => {
    const r = trySkipAnnotatorOnZeroFindings('No issues identified in the file.', isReadOnly);
    expect(r?.verdict).toBe('approved');
  });

  it('SHORT-CIRCUITS on "All checks pass" (verify happy path)', () => {
    const r = trySkipAnnotatorOnZeroFindings('All checks pass for the requested checklist.', isReadOnly);
    expect(r?.verdict).toBe('approved');
  });

  it('SHORT-CIRCUITS case-insensitively', () => {
    expect(trySkipAnnotatorOnZeroFindings('NO FINDINGS', isReadOnly)?.verdict).toBe('approved');
    expect(trySkipAnnotatorOnZeroFindings('No Concerns.', isReadOnly)?.verdict).toBe('approved');
  });

  it('does NOT short-circuit when text contains "no findings" but ALSO has Finding heading', () => {
    // Defensive: if the worker says "no findings" yet emits structured
    // findings anyway, the annotator must still run to extract them.
    const out = `I found no findings worth raising at first, but on closer look:\n## Finding 1: a real one\n- Severity: high`;
    expect(trySkipAnnotatorOnZeroFindings(out, isReadOnly)).toBeNull();
  });
});
