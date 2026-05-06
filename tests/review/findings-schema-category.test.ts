import { describe, it, expect } from 'vitest';
import {
  annotatedFindingSchema,
  reviewerEmittedFindingSchema,
} from '../../packages/core/src/review/findings-schema.js';

const baseAnnotated = {
  id: 'F1',
  severity: 'medium' as const,
  claim: 'Auth check missing on /admin endpoint',
  evidence: "router.get('/admin', adminHandler) — no auth middleware applied",
  annotatorConfidence: 60,
  evidenceGrounded: true,
};

const baseReviewerEmitted = {
  id: 'F1',
  severity: 'medium' as const,
  claim: 'Auth check missing on /admin endpoint',
  evidence: "router.get('/admin', adminHandler) — no auth middleware applied",
  annotatorConfidence: 60,
};

describe('annotatedFindingSchema.category', () => {
  it('accepts a finding without category (backwards compat)', () => {
    expect(annotatedFindingSchema.safeParse(baseAnnotated).success).toBe(true);
  });

  it('accepts a finding with a valid category', () => {
    const r = annotatedFindingSchema.safeParse({ ...baseAnnotated, category: 'security' });
    expect(r.success).toBe(true);
  });

  it('rejects a finding with an unknown category', () => {
    const r = annotatedFindingSchema.safeParse({ ...baseAnnotated, category: 'invented_bucket' });
    expect(r.success).toBe(false);
  });
});

describe('reviewerEmittedFindingSchema.category', () => {
  it('accepts a finding without category (reviewer may omit)', () => {
    expect(reviewerEmittedFindingSchema.safeParse(baseReviewerEmitted).success).toBe(true);
  });

  it('accepts a finding with a valid category', () => {
    const r = reviewerEmittedFindingSchema.safeParse({ ...baseReviewerEmitted, category: 'doc_gap' });
    expect(r.success).toBe(true);
  });
});
