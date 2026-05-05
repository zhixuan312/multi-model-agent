// packages/server/src/http/wire/execute-plan-wire.ts
import { z } from 'zod';
import {
  ToolSurfaceRegistry,
  ReviewerEngine,
  ReviewerPromptBuilder,
  specTemplate,
  qualityAPTemplate,
  diffTemplate,
} from '@zhixuan92/multi-model-agent-core';
import type { RunnerShell } from '@zhixuan92/multi-model-agent-core';

export const executePlanInputSchema = z.object({
  filePaths: z.array(z.string()).length(1, { message: "execute_plan requires exactly one plan filePath" }),
  taskDescriptors: z.array(z.string()).min(1),
  cwd: z.string().optional(),
  perTaskReviewPolicy: z.record(z.string(), z.enum(['full', 'quality_only', 'diff_only', 'none'])).optional(),
  // NOTE: no `agentType` field. .strict() below makes any caller-supplied
  // agentType a Zod parse failure → HTTP 400 with `error: 'invalid_request'`.
}).strict();

export type ExecutePlanWireInput = z.infer<typeof executePlanInputSchema>;

export function registerExecutePlan(registry: ToolSurfaceRegistry): void {
  registry.register({
    routeName: 'execute_plan',
    schema: executePlanInputSchema,
    toolCategory: 'artifact_producing',
    agentTypeDefault: 'standard',
    agentTypeOverridable: false,   // locked-standard per spec C8
    responseShapeName: 'BatchResponse',
  });
}

export function makeExecutePlanReviewer(shell: RunnerShell): ReviewerEngine {
  const builder = new ReviewerPromptBuilder({ spec: specTemplate, qualityForAP: qualityAPTemplate, diff: diffTemplate });
  return new ReviewerEngine(shell, builder);
}
