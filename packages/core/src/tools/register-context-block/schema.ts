import { z } from 'zod';

export const inputSchema = z.object({
  type: z.string().min(1).describe(
    'Block type — caller-defined classifier (e.g. "brief", "spec", "plan", "investigation"). Used by callers to organize block IDs.',
  ),
  description: z.string().min(1).describe(
    'Short human-readable label for the block, surfaced in retrieval.',
  ),
  body: z.string().min(1).describe(
    'Full content of the block. Stored as-is; expanded into briefs when referenced via contextBlockIds.',
  ),
}).strict();

export type RegisterContextBlockInput = z.infer<typeof inputSchema>;
