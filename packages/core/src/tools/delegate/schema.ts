// packages/core/src/tool-schemas/delegate.ts
import { z } from 'zod';
import { buildOutputEnvelopeSchema } from '../shared-output.js';

const taskSchema = z.object({
  prompt: z.string().describe(
    'The task instruction. Required.',
  ),
  agentType: z.enum(['standard', 'complex']).optional().default('standard').describe(
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
  outputTargets: z.array(z.string().min(1)).optional()
    .describe('Output files the worker is expected to produce. Validated post-task; missing paths surface as a structured finding. Paths may be absolute or relative to cwd; relatives are normalized against cwd. Reject entries that escape cwd.'),
  reviewPolicy: z.enum(['full', 'quality_only', 'diff_only', 'none']).optional().default('full').describe(
    'Review lifecycle policy for this task. Default: full.',
  ),
}).strict();

export const inputSchema = z.object({
  tasks: z.array(taskSchema).describe('Array of tasks to execute (parallel by default)'),
  execution: z.enum(['parallel', 'serial']).optional().describe(
    'Override dispatch scheduling for this batch. Default: parallel (tasks run concurrently). Set "serial" to run tasks one-at-a-time in array order.',
  ),
}).strict();

export type Input = z.infer<typeof inputSchema>;

export const outputSchema = buildOutputEnvelopeSchema();

export type Output = z.infer<typeof outputSchema>;
