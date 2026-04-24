// packages/core/src/tool-schemas/delegate.ts
import { z } from 'zod';

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
}).strict();

export const inputSchema = z.object({
  tasks: z.array(taskSchema).describe('Array of tasks to execute in parallel'),
}).strict();

export type Input = z.infer<typeof inputSchema>;

// Uniform output envelope — required for GET /batch/:id?taskIndex=N slicing (see spec §6.5)
export const outputSchema = z.object({
  results: z.array(z.unknown()),           // per-task RunResult, index-aligned with input tasks
  headline: z.string(),
  batchTimings: z.object({}).passthrough(),
  costSummary: z.object({}).passthrough(),
}).passthrough();

export type Output = z.infer<typeof outputSchema>;
