import { z } from 'zod';
import { ToolSurfaceRegistry } from '../../tool-surface/tool-surface-registry.js';
import { ReviewerEngine } from '../../review/reviewer-engine.js';
import {
  ReviewerPromptBuilder,
  specTemplate,
  qualityAPTemplate,
  diffTemplate,
} from '../../review/reviewer-engine.js';
import type { RunnerShell } from '../../providers/runner-shell.js';

export const executePlanInputSchema = z.object({
  filePaths: z.array(z.string()).length(1, { message: "execute_plan requires exactly one plan filePath" }),
  taskDescriptors: z.array(z.string()).min(1),
  cwd: z.string().optional(),
  perTaskReviewPolicy: z.record(z.string(), z.enum(['full', 'quality_only', 'diff_only', 'none'])).optional(),
}).strict();

export type ExecutePlanWireInput = z.infer<typeof executePlanInputSchema>;

export function registerExecutePlan(registry: ToolSurfaceRegistry): void {
  registry.register({
    routeName: 'execute_plan',
    httpMethod: 'POST',
    httpPath: '/execute-plan',
    surface: 'tool',
    schema: executePlanInputSchema,
    toolCategory: 'artifact_producing',
    agentTypeDefault: 'standard',
    agentTypeOverridable: false,
    responseShapeName: 'BatchResponse',
  });
}

export function makeExecutePlanReviewer(shell: RunnerShell): ReviewerEngine {
  const builder = new ReviewerPromptBuilder({ spec: specTemplate, qualityForAP: qualityAPTemplate, diff: diffTemplate });
  return new ReviewerEngine(shell, builder);
}
