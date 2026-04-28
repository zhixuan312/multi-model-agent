import { describe, expect, it } from 'vitest';
import { buildOutputEnvelopeSchema } from '../../packages/core/src/tool-schemas/shared-output.js';

const baseEnvelope = {
  headline: 'audit: 1/1 tasks complete',
  results: [],
  batchTimings: { wallClockMs: 0, sumOfTaskMs: 0, estimatedParallelSavingsMs: 0 },
  costSummary: { totalActualCostUSD: 0, totalSavedCostUSD: 0 },
  structuredReport: { kind: 'not_applicable', reason: 'x' },
  error: { kind: 'not_applicable', reason: 'x' },
  proposedInterpretation: { kind: 'not_applicable', reason: 'x' },
} as const;

describe('envelope verdict fields', () => {
  const schema = buildOutputEnvelopeSchema({});

  it('accepts envelope with all three verdict fields populated', () => {
    const result = schema.safeParse({
      ...baseEnvelope,
      batchId: '00000000-0000-0000-0000-000000000000',
      wallClockMs: 0,
      parentModel: 'm',
      specReviewVerdict: 'not_applicable',
      qualityReviewVerdict: 'approved',
      roundsUsed: 1,
    });
    expect(result.success).toBe(true);
  });

  it('accepts envelope omitting the new verdict fields (optional)', () => {
    const result = schema.safeParse({
      ...baseEnvelope,
      batchId: '00000000-0000-0000-0000-000000000000',
      wallClockMs: 0,
      parentModel: 'm',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.specReviewVerdict).toBeUndefined();
      expect(result.data.qualityReviewVerdict).toBeUndefined();
      expect(result.data.roundsUsed).toBeUndefined();
    }
  });

  it('accepts roundsUsed: 0 for kill-switched topology', () => {
    const result = schema.safeParse({
      ...baseEnvelope,
      batchId: '00000000-0000-0000-0000-000000000000',
      wallClockMs: 0,
      parentModel: 'm',
      specReviewVerdict: 'not_applicable',
      qualityReviewVerdict: 'skipped',
      roundsUsed: 0,
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid verdict values', () => {
    const result = schema.safeParse({
      ...baseEnvelope,
      batchId: '00000000-0000-0000-0000-000000000000',
      wallClockMs: 0,
      parentModel: 'm',
      specReviewVerdict: 'not_a_valid_verdict',
      qualityReviewVerdict: 'approved',
      roundsUsed: 1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects negative roundsUsed', () => {
    const result = schema.safeParse({
      ...baseEnvelope,
      batchId: '00000000-0000-0000-0000-000000000000',
      wallClockMs: 0,
      parentModel: 'm',
      specReviewVerdict: 'not_applicable',
      qualityReviewVerdict: 'approved',
      roundsUsed: -1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-integer roundsUsed', () => {
    const result = schema.safeParse({
      ...baseEnvelope,
      batchId: '00000000-0000-0000-0000-000000000000',
      wallClockMs: 0,
      parentModel: 'm',
      specReviewVerdict: 'not_applicable',
      qualityReviewVerdict: 'approved',
      roundsUsed: 1.5,
    });
    expect(result.success).toBe(false);
  });
});
