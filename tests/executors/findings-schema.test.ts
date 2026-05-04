import { describe, it, expect } from 'vitest';
import {
  annotatedFindingSchema,
  annotatedFindingsSchema,
  reviewerEmittedFindingSchema,
  evidenceIsGrounded,
  normalizeWhitespace,
} from '../../packages/core/src/executors/_shared/findings-schema.js';

const VALID_EVIDENCE =
  'src/auth/login.ts:89 — req.body.user is dereferenced without a guard, throws on missing body';

describe('annotatedFindingSchema', () => {
  it('accepts a critical-severity finding', () => {
    const result = annotatedFindingSchema.safeParse({
      id: 'F1', severity: 'critical', claim: 'remote code execution',
      evidence: VALID_EVIDENCE, annotatorConfidence: 95, evidenceGrounded: true,
    });
    expect(result.success).toBe(true);
  });

  it('accepts null annotatorConfidence (fallback path)', () => {
    const result = annotatedFindingSchema.safeParse({
      id: 'F1', severity: 'high', claim: 'x',
      evidence: VALID_EVIDENCE, annotatorConfidence: null, evidenceGrounded: true,
    });
    expect(result.success).toBe(true);
  });

  it('rejects reviewerSeverity (field removed in 3.10.5)', () => {
    const result = annotatedFindingSchema.safeParse({
      id: 'F1', severity: 'high', claim: 'x',
      evidence: VALID_EVIDENCE, annotatorConfidence: 80, evidenceGrounded: true,
      reviewerSeverity: 'medium',
    });
    expect(result.success).toBe(false);
  });

  it('requires evidenceGrounded', () => {
    const result = annotatedFindingSchema.safeParse({
      id: 'F1', severity: 'high', claim: 'x',
      evidence: VALID_EVIDENCE, annotatorConfidence: 80,
    });
    expect(result.success).toBe(false);
  });

  it('rejects evidence shorter than 20 chars', () => {
    const result = annotatedFindingSchema.safeParse({
      id: 'F1', severity: 'high', claim: 'x', evidence: 'too short',
      annotatorConfidence: 50, evidenceGrounded: false,
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown severity', () => {
    const result = annotatedFindingSchema.safeParse({
      id: 'F1', severity: 'urgent', claim: 'x',
      evidence: VALID_EVIDENCE, annotatorConfidence: 50, evidenceGrounded: true,
    });
    expect(result.success).toBe(false);
  });

  it('rejects out-of-range annotatorConfidence when not null', () => {
    const result = annotatedFindingSchema.safeParse({
      id: 'F1', severity: 'high', claim: 'x',
      evidence: VALID_EVIDENCE, annotatorConfidence: 150, evidenceGrounded: true,
    });
    expect(result.success).toBe(false);
  });
});

describe('annotatedFindingsSchema', () => {
  it('rejects duplicate ids', () => {
    const result = annotatedFindingsSchema.safeParse([
      { id: 'F1', severity: 'high', claim: 'a', evidence: VALID_EVIDENCE, annotatorConfidence: 50, evidenceGrounded: true },
      { id: 'F1', severity: 'low', claim: 'b', evidence: VALID_EVIDENCE, annotatorConfidence: 30, evidenceGrounded: true },
    ]);
    expect(result.success).toBe(false);
  });
});

describe('reviewerEmittedFindingSchema', () => {
  it('rejects null annotatorConfidence (only the parser-output schema allows null)', () => {
    const result = reviewerEmittedFindingSchema.safeParse({
      id: 'F1', severity: 'high', claim: 'x',
      evidence: VALID_EVIDENCE, annotatorConfidence: null,
    });
    expect(result.success).toBe(false);
  });

  it('does NOT include evidenceGrounded (parser adds it)', () => {
    const result = reviewerEmittedFindingSchema.safeParse({
      id: 'F1', severity: 'high', claim: 'x',
      evidence: VALID_EVIDENCE, annotatorConfidence: 80, evidenceGrounded: true,
    });
    expect(result.success).toBe(false);
  });

  it('rejects reviewerSeverity (field removed)', () => {
    const result = reviewerEmittedFindingSchema.safeParse({
      id: 'F1', severity: 'high', claim: 'x',
      evidence: VALID_EVIDENCE, annotatorConfidence: 80,
      reviewerSeverity: 'medium',
    });
    expect(result.success).toBe(false);
  });
});

describe('normalizeWhitespace', () => {
  it('collapses runs of whitespace and trims', () => {
    expect(normalizeWhitespace('  a\n  b\t c  ')).toBe('a b c');
  });
});

describe('evidenceIsGrounded', () => {
  const worker = 'The function `parseRequest` in src/foo.ts:42 returns null when body is undefined.';

  it('matches a verbatim quote ≥20 chars', () => {
    expect(evidenceIsGrounded('src/foo.ts:42 returns null when body is undefined', worker)).toBe(true);
  });

  it('matches when whitespace differs', () => {
    expect(evidenceIsGrounded('src/foo.ts:42  returns   null  when body is undefined', worker)).toBe(true);
  });

  it('rejects when not a substring', () => {
    expect(evidenceIsGrounded('src/bar.ts:99 throws on undefined body — fabricated phrase', worker)).toBe(false);
  });

  it('rejects evidence shorter than 20 chars even if substring', () => {
    expect(evidenceIsGrounded('src/foo.ts', worker)).toBe(false);
  });
});
