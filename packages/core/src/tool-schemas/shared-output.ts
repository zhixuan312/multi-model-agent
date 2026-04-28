import { z } from 'zod';
import { notApplicableSchema } from '../reporting/not-applicable.js';

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

const REVIEW_VERDICT_SCHEMA = z.enum([
  'approved', 'concerns', 'changes_required', 'error', 'skipped', 'not_applicable',
]);

// Envelope builder — single source of truth.
export function buildOutputEnvelopeSchema(resultItemSchema: z.ZodTypeAny = z.unknown()) {
  return z.object({
    headline: z.string().min(1),
    results: z.union([z.array(resultItemSchema), notApplicableSchema]),
    batchTimings: z.union([batchTimingsSchema, notApplicableSchema]),
    costSummary: z.union([costSummarySchema, notApplicableSchema]),
    structuredReport: z.union([structuredReportSchema, notApplicableSchema]),
    error: z.union([errorSchema, notApplicableSchema]),
    proposedInterpretation: z.union([z.string().min(1), notApplicableSchema]),
    specReviewVerdict: REVIEW_VERDICT_SCHEMA.optional(),
    qualityReviewVerdict: REVIEW_VERDICT_SCHEMA.optional(),
    roundsUsed: z.number().int().min(0).optional(),
  }).passthrough();
}
