import { z } from 'zod';
import type { AnySource } from './types.js';

const delegateSourceSchema = z.object({
  route: z.literal('delegate_tasks'),
  originalInput: z.record(z.string(), z.unknown()),
});

const reviewSourceSchema = z.object({
  route: z.literal('review_code'),
  originalInput: z.record(z.string(), z.unknown()),
  code: z.string().optional(),
  inlineContent: z.string().optional(),
  focus: z.array(z.string()).optional(),
});

const debugSourceSchema = z.object({
  route: z.literal('debug_task'),
  originalInput: z.record(z.string(), z.unknown()),
  problem: z.string(),
  context: z.string().optional(),
  hypothesis: z.string().optional(),
});

const verifySourceSchema = z.object({
  route: z.literal('verify_work'),
  originalInput: z.record(z.string(), z.unknown()),
  checklist: z.array(z.string()),
  work: z.string().optional(),
});

const auditSourceSchema = z.object({
  route: z.literal('audit_document'),
  originalInput: z.record(z.string(), z.unknown()),
  document: z.string().optional(),
  auditType: z.string().optional(),
});

const sourceSchema = z.discriminatedUnion('route', [
  delegateSourceSchema,
  reviewSourceSchema,
  debugSourceSchema,
  verifySourceSchema,
  auditSourceSchema,
]);

export function validateSource(source: unknown): AnySource {
  return sourceSchema.parse(source) as AnySource;
}

export function isValidSource(source: unknown): boolean {
  return sourceSchema.safeParse(source).success;
}
