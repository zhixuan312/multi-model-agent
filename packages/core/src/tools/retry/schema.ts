// packages/core/src/tools/retry/schema.ts
import { z } from 'zod';
import { buildOutputEnvelopeSchema } from '../shared-output.js';

// Goal mode: retry re-fires a prior write goal-set against the CURRENT git
// HEAD (the new baseSha). Because git holds all committed progress, the re-run
// continues/repairs rather than redoing finished work. There is no task-index
// subset — a single autonomous run has no MMA-controlled task boundary.
export const inputSchema = z.object({
  batchId: z.string().describe('Batch id returned from a previous delegate / execute-plan / journal-record call'),
});

export type Input = z.infer<typeof inputSchema>;

export const outputSchema = buildOutputEnvelopeSchema();

export type Output = z.infer<typeof outputSchema>;
