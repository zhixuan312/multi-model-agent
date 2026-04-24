import { z } from 'zod';

export const notApplicableSchema = z.object({
  kind: z.literal('not_applicable'),
  reason: z.string().min(1),
});

export type NotApplicable = z.infer<typeof notApplicableSchema>;

export function notApplicable(reason: string): NotApplicable {
  return { kind: 'not_applicable', reason };
}

export function isNotApplicable(v: unknown): v is NotApplicable {
  return typeof v === 'object' && v !== null && (v as NotApplicable).kind === 'not_applicable';
}
