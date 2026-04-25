// packages/core/src/tool-schemas/delegate.ts
import { z } from 'zod';
import { buildOutputEnvelopeSchema } from './shared-output.js';

// Inline copy of the task shape from packages/mcp/src/cli.ts buildTaskSchema().
// agentType is z.string() here (not an enum) because core does not know the
// runtime agent names — the MCP layer constrains to an enum at registration time.
const taskSchema = z.object({
  prompt: z.string().describe(
    'The task instruction. Required.',
  ),
  agentType: z.string().optional().describe(
    'How hard the task is. Default: standard (cost-effective). Set to complex for harder reasoning or ambiguous scope.',
  ),
  filePaths: z.array(z.string()).optional().describe(
    'Files the sub-agent should focus on. Existing files are pre-verified. Non-existent paths are treated as output targets.',
  ),
  done: z.string().optional().describe(
    'Acceptance criteria in plain language. The worker works toward this goal. The reviewer verifies it.',
  ),
  contextBlockIds: z.array(z.string()).optional().describe(
    'IDs from register_context_block to prepend to prompt.',
  ),
  maxReviewRounds: z.number().int().min(0).max(10).default(3).describe(
    'Maximum combined spec/quality review rework rounds before the review loop aborts.',
  ),
  maxCostUSD: z.number().positive().finite().optional().describe(
    'Maximum estimated cost in USD for this task. Optional; the executor applies a default of 10 when omitted. When explicitly passed it must be a positive finite number; <=0, NaN, or Infinity are rejected with HTTP 400.',
  ),
  verifyCommand: z.array(z.string().refine((s) => s.trim().length > 0, 'non-empty after trim')).min(1).optional().describe(
    'Commands to run after task completion to verify the work.',
  ),
  reviewPolicy: z.enum(['full', 'spec_only', 'diff_only', 'off']).optional().default('full').describe(
    'Review lifecycle policy for this task. Default: full.',
  ),
}).strict();

export const inputSchema = z.object({
  tasks: z.array(taskSchema).describe('Array of tasks to execute in parallel'),
}).strict();

export type Input = z.infer<typeof inputSchema>;

export const outputSchema = buildOutputEnvelopeSchema();

export type Output = z.infer<typeof outputSchema>;
