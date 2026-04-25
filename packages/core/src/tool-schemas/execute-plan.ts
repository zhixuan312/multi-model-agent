// packages/core/src/tool-schemas/execute-plan.ts
import { z } from 'zod';
import { buildOutputEnvelopeSchema } from './shared-output.js';

// Ported verbatim from packages/mcp/src/tools/execute-plan.ts (executePlanSchema).
// commonToolFields (filePaths + contextBlockIds) are inlined to avoid cross-package coupling.
const taskSchema = z.object({
  task: z.string().trim().min(1, 'Task descriptor must be non-empty'),
  reviewPolicy: z.enum(['full', 'spec_only', 'diff_only', 'off']).optional().default('full')
    .describe('Review lifecycle policy for this task. Default: full.'),
}).strict();

const taskInputSchema = z.union([
  z.string().trim().min(1, 'Task descriptor must be non-empty'),
  taskSchema,
]);

function taskDescriptor(task: z.infer<typeof taskInputSchema>): string {
  return typeof task === 'string' ? task : task.task;
}

export const inputSchema = z.object({
  tasks: z.array(
    taskInputSchema,
  ).min(1, 'At least one task required')
    .refine(
      (tasks) => new Set(tasks.map(taskDescriptor)).size === tasks.length,
      { message: 'Duplicate task descriptors are not allowed' },
    )
    .describe('Descriptive task strings or task objects matching plan headings, e.g. "1. Setup database schema". Multiple = parallel.'),
  context: z.string().optional()
    .describe('Short additional context the plan does not contain, e.g. "Tasks 1-16 are done, files already exist". Injected into the worker prompt.'),
  filePaths: z.array(z.string()).optional()
    .describe('Files the sub-agent should focus on. Multiple files are processed in parallel.'),
  contextBlockIds: z.array(z.string()).optional()
    .describe('IDs from register_context_block to prepend to prompt. Use for delta audits, diff-scoped reviews, or shared specs.'),
  agentType: z.enum(['standard', 'complex']).optional()
    .describe('Worker tier. Default: "standard" (cost-effective). Set to "complex" for harder plan tasks that a smaller model cannot finish in the turn budget.'),
  maxCostUSD: z.number().positive().finite().optional()
    .describe('Maximum estimated cost in USD for each generated plan task. Optional; the executor applies a default of 10 when omitted. Validation when explicitly passed: positive finite.'),
  verifyCommand: z.array(z.string().refine((s) => s.trim().length > 0, 'non-empty after trim')).min(1).optional()
    .describe('Commands to run after plan task completion to verify the work.'),
}).strict();

export type Input = z.infer<typeof inputSchema>;

export const outputSchema = buildOutputEnvelopeSchema();

export type Output = z.infer<typeof outputSchema>;
