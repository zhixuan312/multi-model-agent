import { describe, expect, it } from 'vitest';
import {
  workerFindingSchema,
  workerFindingsSchema,
  annotatedFindingSchema,
  annotatedFindingsSchema,
} from '../../packages/core/src/executors/_shared/findings-schema.js';

const VALID_EVIDENCE = 'src/auth/login.ts:89 — the property access is unguarded against undefined req.body.user';

describe('workerFindingSchema', () => {
  it('accepts a fully-populated worker finding', () => {
    const result = workerFindingSchema.safeParse({
      id: 'F1',
      severity: 'high',
      claim: 'Missing null check on req.body.user',
      evidence: VALID_EVIDENCE,
      suggestion: 'Wrap in optional chaining.',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a finding without optional suggestion', () => {
    const result = workerFindingSchema.safeParse({
      id: 'F2',
      severity: 'low',
      claim: 'Typo in heading.',
      evidence: 'README.md:12 — the heading reads "Intsallation" not "Installation"',
    });
    expect(result.success).toBe(true);
  });

  it('rejects evidence shorter than 20 chars', () => {
    const result = workerFindingSchema.safeParse({
      id: 'F3',
      severity: 'medium',
      claim: 'x',
      evidence: 'short',
    });
    expect(result.success).toBe(false);
  });

  it('rejects uppercase severity', () => {
    const result = workerFindingSchema.safeParse({
      id: 'F4', severity: 'HIGH', claim: 'x', evidence: VALID_EVIDENCE,
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown fields (file/line/sourceQuote)', () => {
    const result = workerFindingSchema.safeParse({
      id: 'F5', severity: 'low', claim: 'x', evidence: VALID_EVIDENCE,
      file: 'a.ts', line: 1, sourceQuote: 'snippet',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing id, severity, claim, or evidence', () => {
    expect(workerFindingSchema.safeParse({ severity: 'low', claim: 'x', evidence: VALID_EVIDENCE }).success).toBe(false);
    expect(workerFindingSchema.safeParse({ id: 'F1', claim: 'x', evidence: VALID_EVIDENCE }).success).toBe(false);
    expect(workerFindingSchema.safeParse({ id: 'F1', severity: 'low', evidence: VALID_EVIDENCE }).success).toBe(false);
    expect(workerFindingSchema.safeParse({ id: 'F1', severity: 'low', claim: 'x' }).success).toBe(false);
  });
});

describe('workerFindingsSchema (array with id-uniqueness)', () => {
  it('accepts an empty array', () => {
    expect(workerFindingsSchema.safeParse([]).success).toBe(true);
  });

  it('accepts an array of valid findings with unique ids', () => {
    const result = workerFindingsSchema.safeParse([
      { id: 'F1', severity: 'high', claim: 'a', evidence: VALID_EVIDENCE },
      { id: 'F2', severity: 'low', claim: 'b', evidence: VALID_EVIDENCE },
    ]);
    expect(result.success).toBe(true);
  });

  it('rejects duplicate ids within the array', () => {
    const result = workerFindingsSchema.safeParse([
      { id: 'F1', severity: 'high', claim: 'a', evidence: VALID_EVIDENCE },
      { id: 'F1', severity: 'low', claim: 'b', evidence: VALID_EVIDENCE },
    ]);
    expect(result.success).toBe(false);
  });
});

describe('annotatedFindingSchema', () => {
  it('accepts a worker finding plus reviewer fields', () => {
    const result = annotatedFindingSchema.safeParse({
      id: 'F1',
      severity: 'high',
      claim: 'a',
      evidence: VALID_EVIDENCE,
      reviewerConfidence: 85,
    });
    expect(result.success).toBe(true);
  });

  it('accepts reviewerSeverity disagreement', () => {
    const result = annotatedFindingSchema.safeParse({
      id: 'F1', severity: 'high', claim: 'a', evidence: VALID_EVIDENCE,
      reviewerConfidence: 40, reviewerSeverity: 'low',
    });
    expect(result.success).toBe(true);
  });

  it('rejects reviewerConfidence above 100', () => {
    expect(annotatedFindingSchema.safeParse({
      id: 'F1', severity: 'high', claim: 'a', evidence: VALID_EVIDENCE, reviewerConfidence: 101,
    }).success).toBe(false);
  });

  it('rejects reviewerConfidence below 0', () => {
    expect(annotatedFindingSchema.safeParse({
      id: 'F1', severity: 'high', claim: 'a', evidence: VALID_EVIDENCE, reviewerConfidence: -1,
    }).success).toBe(false);
  });

  it('rejects non-integer reviewerConfidence', () => {
    expect(annotatedFindingSchema.safeParse({
      id: 'F1', severity: 'high', claim: 'a', evidence: VALID_EVIDENCE, reviewerConfidence: 50.5,
    }).success).toBe(false);
  });

  it('rejects missing reviewerConfidence', () => {
    expect(annotatedFindingSchema.safeParse({
      id: 'F1', severity: 'high', claim: 'a', evidence: VALID_EVIDENCE,
    }).success).toBe(false);
  });
});

describe('annotatedFindingsSchema', () => {
  it('accepts an empty array', () => {
    expect(annotatedFindingsSchema.safeParse([]).success).toBe(true);
  });

  it('accepts a valid annotated array', () => {
    const result = annotatedFindingsSchema.safeParse([
      { id: 'F1', severity: 'high', claim: 'a', evidence: VALID_EVIDENCE, reviewerConfidence: 80 },
      { id: 'F2', severity: 'low', claim: 'b', evidence: VALID_EVIDENCE, reviewerConfidence: 35, reviewerSeverity: 'low' },
    ]);
    expect(result.success).toBe(true);
  });
});
