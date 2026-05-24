import { ToolSurfaceRegistry } from '../../../tool-surface/tool-surface-registry.js';
import { inputSchema } from './schema.js';
import type { Input } from './schema.js';
import type { ToolConfig } from '../../../lifecycle/tool-config-types.js';
import { journalHeadlineTemplate } from '../../../reporting/headline-templates/journal.js';
import { journalReportSchema } from '../../../reporting/report-parser-slots/journal-report.js';
import { journalRecordBriefSlot, type JournalRecordBrief } from './brief-slot.js';
import { DEFAULT_TASK_TIMEOUT_MS } from '../../../config/schema.js';

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
  buildTaskSpec: (brief, ctx) => ({
    prompt: brief.prompt,
    agentType: brief.agentType,
    reviewPolicy: brief.reviewPolicy,
    contextBlockIds: brief.contextBlockIds,
    cwd: ctx.projectContext?.cwd ?? ctx.cwd,
    tools: ctx.config.defaults?.tools ?? 'full',
    timeoutMs: ctx.config.defaults?.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS,
    sandboxPolicy: ctx.config.defaults?.sandboxPolicy ?? 'cwd-only',
  }),
  reportSchema: journalReportSchema,
  headlineTemplate: journalHeadlineTemplate,
};
