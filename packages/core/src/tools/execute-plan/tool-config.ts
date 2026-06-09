import { z } from 'zod';
import { buildOutputEnvelopeSchema } from '../shared-output.js';
import { ToolSurfaceRegistry } from '../../tool-surface/tool-surface-registry.js';
import type { ToolConfig } from '../../lifecycle/tool-config-types.js';
import { executePlanBriefSlot, type ExecutePlanBrief } from './brief-slot.js';
import { executePlanHeadlineTemplate } from '../../reporting/headline-templates/execute-plan.js';
import { executePlanReportSchema } from '../../reporting/report-parser-slots/execute-plan-report.js';
import { DEFAULT_TASK_TIMEOUT_MS } from '../../config/schema.js';
import { assembleGoal, goalToTaskSpec } from '../../lifecycle/goal-builder.js';
import { implementGoalPrompt } from '../../lifecycle/goal-prompts.js';

export const executePlanInputSchema = z.object({
  filePaths: z.array(z.string()).length(1, { message: "execute_plan requires exactly one plan filePath" }),
  taskDescriptors: z.array(z.string()).min(1),
  cwd: z.string().optional(),
  perTaskReviewPolicy: z.record(z.string(), z.enum(['full', 'quality_only', 'diff_only', 'none'])).optional(),
  contextBlockIds: z.array(z.string()).optional(),
}).strict();

export type ExecutePlanWireInput = z.infer<typeof executePlanInputSchema>;

/** Output envelope schema — the single source for the public `executePlan`
 *  barrel namespace (was duplicated in the now-deleted execute-plan/schema.ts). */
export const outputSchema = buildOutputEnvelopeSchema();

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

export const toolConfig: ToolConfig<ExecutePlanWireInput, ExecutePlanBrief> = {
  name: 'execute_plan',
  category: 'artifact_producing',
  dispatchMode: 'serial',
  dispatchModeOverridable: false,
  agentType: 'standard',
  briefSlot: executePlanBriefSlot,
  buildTaskSpec: (brief, ctx) => {
    const goal = assembleGoal({
      source: 'execute-plan',
      // ctx.cwd is the HTTP `?cwd=` query param; prefer it over the brief's
      // (which is only set when the caller put cwd in the body).
      cwd: ctx.cwd ?? brief.cwd,
      tasks: brief.tasks,
      phases: [{ tier: 'standard', mode: 'implement' }, { tier: 'complex', mode: 'review-fix' }],
      reviewPolicy: brief.reviewPolicy,
      tools: ctx.config.defaults?.tools ?? 'full',
      sandboxPolicy: ctx.config.defaults?.sandboxPolicy ?? 'cwd-only',
      ...(brief.contextBlockIds.length > 0 && { contextBlockIds: brief.contextBlockIds }),
    });
    return goalToTaskSpec(goal, implementGoalPrompt(goal), DEFAULT_TASK_TIMEOUT_MS);
  },
  reportSchema: executePlanReportSchema,
  headlineTemplate: executePlanHeadlineTemplate,
};
