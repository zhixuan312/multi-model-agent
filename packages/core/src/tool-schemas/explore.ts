import { z } from 'zod';

const Trimmed = (min: number, max: number) =>
  z.string().trim().min(min, `min length ${min}`).max(max, `max length ${max}`);

const ALLOWED_KEYS = new Set([
  'currentContext', 'explorationQuestion', 'anchors', 'contextBlockIds',
]);
const BLOCKED_KEYS_TO_CODE: Record<string, string> = {
  agentType: 'tier_not_overridable',
  tools: 'tool_surface_not_overridable',
};

const ExploreInputBase = z.object({
  currentContext: Trimmed(20, 8000),
  explorationQuestion: Trimmed(20, 8000),
  anchors: z.array(z.string().min(1).max(512)).max(32).default([]),
  contextBlockIds: z.array(z.string().min(1)).max(16).default([]),
});

// Single-pass scan that emits ALL key-shape errors deterministically and
// returns `z.NEVER` if any blocked or unknown key was found, preventing the
// typed pipe stage from running on malformed input. This avoids the
// double-error problem where both .superRefine() AND .strict() flag the same
// blocked field.
//
// Export name: `inputSchema` (lowercase) — matches `tool-schemas/investigate.ts`
// convention (verified Plan R6).
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

    // Phase 1: blocked keys, in deterministic order (agentType before tools).
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

    // Phase 2: any other unknown key, in lexicographic order.
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
  .pipe(ExploreInputBase); // typed validation only runs on key-clean objects

export type Input = z.infer<typeof inputSchema>;
