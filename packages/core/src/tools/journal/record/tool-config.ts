import { ToolSurfaceRegistry } from '../../../tool-surface/tool-surface-registry.js';
import { inputSchema } from './schema.js';
import type { Input } from './schema.js';
import type { ToolConfig } from '../../../lifecycle/tool-config-types.js';
import { journalHeadlineTemplate } from '../../../reporting/headline-templates/journal.js';
import { journalReportSchema } from '../../../reporting/report-parser-slots/journal-report.js';
import { journalRecordBriefSlot, type JournalRecordBrief } from './brief-slot.js';
import { DEFAULT_TASK_TIMEOUT_MS } from '../../../config/schema.js';
import { assembleGoal, goalToTaskSpec } from '../../../lifecycle/goal-builder.js';
import { implementGoalPrompt } from '../../../lifecycle/goal-prompts.js';

export function registerJournalRecord(registry: ToolSurfaceRegistry): void {
  registry.register({
    routeName: 'journal-record',
    httpMethod: 'POST',
    httpPath: '/journal-record',
    surface: 'tool',
    schema: inputSchema,
    toolCategory: 'artifact_producing',
    agentTypeDefault: 'complex',
    agentTypeOverridable: false,
    responseShapeName: 'BatchResponse',
  });
}

export const toolConfig: ToolConfig<Input, JournalRecordBrief, unknown> = {
  name: 'journal-record',
  category: 'artifact_producing',
  dispatchMode: 'serial',
  dispatchModeOverridable: false,
  agentType: 'complex',
  briefSlot: journalRecordBriefSlot,
  buildTaskSpec: (brief, ctx) => {
    const goal = assembleGoal({
      source: 'journal-record',
      cwd: ctx.projectContext?.cwd ?? ctx.cwd,
      tasks: brief.tasks,
      // Journal integration is nuanced — complex on both phases.
      phases: [{ tier: 'complex', mode: 'implement' }, { tier: 'complex', mode: 'review-fix' }],
      reviewPolicy: 'review-fix',
      tools: ctx.config.defaults?.tools ?? 'full',
      sandboxPolicy: ctx.config.defaults?.sandboxPolicy ?? 'cwd-only',
      preamble: brief.preamble,
      ...(brief.contextBlockIds && brief.contextBlockIds.length > 0 && { contextBlockIds: brief.contextBlockIds }),
    });
    return goalToTaskSpec(goal, implementGoalPrompt(goal), DEFAULT_TASK_TIMEOUT_MS);
  },
  reportSchema: journalReportSchema,
  headlineTemplate: journalHeadlineTemplate,
};
