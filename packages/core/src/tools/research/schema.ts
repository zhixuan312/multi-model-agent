import { z } from 'zod';

const Trimmed = (min: number, max: number) =>
  z.string().trim().min(min, `min length ${min}`).max(max, `max length ${max}`);

const ALLOWED_KEYS = new Set([
  'researchQuestion', 'background', 'contextBlockIds',
]);
const BLOCKED_KEYS_TO_CODE: Record<string, string> = {
  agentType: 'tier_not_overridable',
  tools: 'tool_surface_not_overridable',
};

const ResearchInputBase = z.object({
  researchQuestion: Trimmed(20, 8000),
  background: Trimmed(20, 8000),
  contextBlockIds: z.array(z.string().min(1)).max(16).default([]),
});

// Single-pass deterministic key-shape validator. Mirrors tools/explore/schema.ts
// and tools/investigate/schema.ts (verified Plan R6 for explore). Blocked keys
// emit before unknown keys; both emit before typed validation runs.
export const inputSchema = z
  .unknown()
  .transform((raw, ctx) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'invalid_request: body must be an object',
      });
      return z.NEVER;
    }
    const obj = raw as Record<string, unknown>;
    let bad = false;

    // Phase 1: blocked keys, deterministic order.
    for (const key of ['agentType', 'tools'] as const) {
      if (key in obj) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: BLOCKED_KEYS_TO_CODE[key],
          path: [key],
        });
        bad = true;
      }
    }

    // Phase 2: unknown keys, lexicographic order.
    const unknown = Object.keys(obj)
      .filter((k) => !ALLOWED_KEYS.has(k) && !(k in BLOCKED_KEYS_TO_CODE))
      .sort();
    for (const key of unknown) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'unknown_field',
        path: [key],
      });
      bad = true;
    }

    if (bad) return z.NEVER;
    return obj;
  })
  .pipe(ResearchInputBase);

export type Input = z.infer<typeof inputSchema>;
