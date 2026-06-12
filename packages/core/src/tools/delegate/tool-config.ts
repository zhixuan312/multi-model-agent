import { ToolSurfaceRegistry } from '../../tool-surface/tool-surface-registry.js';
import { inputSchema } from './schema.js';
import type { Input } from './schema.js';
import type { ToolConfig } from '../../lifecycle/tool-config-types.js';
import { delegateHeadlineTemplate } from '../../reporting/headline-templates/delegate.js';
import { delegateReportSchema } from '../../reporting/report-parser-slots/delegate-report.js';
import { delegateBriefSlot, type DelegateBrief } from './brief-slot.js';
import { DEFAULT_TASK_TIMEOUT_MS } from '../../config/schema.js';
import { assembleGoal, goalToTaskSpec } from '../../lifecycle/goal-builder.js';
import { implementGoalPrompt } from '../../lifecycle/goal-prompts.js';

export function registerDelegate(registry: ToolSurfaceRegistry): void {
  registry.register({
    routeName: 'delegate',
    httpMethod: 'POST',
    httpPath: '/delegate',
    surface: 'tool',
    schema: inputSchema,
    toolCategory: 'artifact_producing',
    agentTypeDefault: 'standard',
    agentTypeOverridable: true,
    responseShapeName: 'BatchResponse',
  });
}

export const toolConfig: ToolConfig<Input, DelegateBrief, unknown> = {
  name: 'delegate',
  category: 'artifact_producing',
  // Goal-sets are sequential by construction (one task with two phases).
  dispatchMode: 'serial',
  dispatchModeOverridable: false,
  agentType: 'standard',
  briefSlot: delegateBriefSlot,
  buildTaskSpec: (brief, ctx) => {
    const goal = assembleGoal({
      source: 'delegate',
      cwd: ctx.projectContext?.cwd ?? ctx.cwd,
      tasks: brief.tasks,
      phases: [{ tier: brief.phase1Tier, mode: 'implement' }, { tier: 'complex', mode: 'review-fix' }],
      reviewPolicy: brief.reviewPolicy,
      tools: ctx.config.defaults?.tools ?? 'full',
      sandboxPolicy: ctx.config.defaults?.sandboxPolicy ?? 'cwd-only',
      ...(ctx.config.defaults?.timeoutMs !== undefined && { perTaskTimeoutMs: ctx.config.defaults.timeoutMs }),
      ...(brief.skills && brief.skills.length > 0 && { skills: brief.skills }),
      ...(brief.contextBlockIds && brief.contextBlockIds.length > 0 && { contextBlockIds: brief.contextBlockIds }),
    });
    return goalToTaskSpec(goal, implementGoalPrompt(goal), DEFAULT_TASK_TIMEOUT_MS);
  },
  reportSchema: delegateReportSchema,
  headlineTemplate: delegateHeadlineTemplate,
};
