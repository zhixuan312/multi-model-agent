// Schema infrastructure shared by all 8 per-tool schemas under tools/<tool>/schema.ts.
// `buildOutputEnvelopeSchema` is the single source of truth for the terminal-envelope
// shape every tool returns. Lives in tools/ (not reporting/) because it is part of the
// per-tool input/output contract surface — any change here changes every tool's wire
// schema in lockstep.
import { z } from 'zod';
import { notApplicableSchema } from '../reporting/not-applicable.js';
import { ReviewVerdictEnum } from '../types/enums.js';

// Shared, reusable concrete schemas for terminal-envelope fields.
export const errorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  details: z.unknown().optional(),
});

// These preserve 3.0.x openness — do NOT tighten here. Separate spec item if we ever do.
export const batchTimingsSchema = z.object({}).passthrough();
export const costSummarySchema = z.object({}).passthrough();
export const structuredReportSchema = z.object({}).passthrough();

// Envelope builder — single source of truth.
export function buildOutputEnvelopeSchema(resultItemSchema: z.ZodTypeAny = z.unknown()) {
  return z.object({
    headline: z.string().min(1),
    results: z.union([z.array(resultItemSchema), notApplicableSchema]),
    batchTimings: z.union([batchTimingsSchema, notApplicableSchema]),
    costSummary: z.union([costSummarySchema, notApplicableSchema]),
    structuredReport: z.union([structuredReportSchema, notApplicableSchema]),
    error: z.union([errorSchema, notApplicableSchema]),
    specReviewVerdict: ReviewVerdictEnum.optional(),
    qualityReviewVerdict: ReviewVerdictEnum.optional(),
    roundsUsed: z.number().int().min(0).optional(),
  }).passthrough();
}
