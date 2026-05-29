// packages/core/src/tools/journal/recall/tool-config.ts
import type { ToolSurfaceRegistry } from '../../../tool-surface/tool-surface-registry.js';
import { inputSchema } from './schema.js';
import type { Input } from './schema.js';
import type { ToolConfig } from '../../../lifecycle/tool-config-types.js';
import type { ExecutionContext } from '../../../lifecycle/lifecycle-context.js';
import { investigateReportSchema } from '../../../reporting/report-parser-slots/investigate-report.js';
import type { InvestigateReportOutput } from '../../../reporting/report-parser-slots/investigate-report.js';
import { journalRecallHeadlineTemplate } from '../../../reporting/headline-templates/journal-recall.js';
import { DEFAULT_TASK_TIMEOUT_MS } from '../../../config/schema.js';
import { journalRecallBriefSlot, type JournalRecallBrief } from './brief-slot.js';
import {
  JOURNAL_RECALL_ORIENTATION, JOURNAL_RECALL_PROCEDURE, JOURNAL_RECALL_SEVERITY,
  JOURNAL_RECALL_UNTRUSTED, JOURNAL_RECALL_EMPTY,
} from './implementer-criteria.js';

export function registerJournalRecall(registry: ToolSurfaceRegistry): void {
  registry.register({
    routeName: 'journal-recall',
    httpMethod: 'POST',
    httpPath: '/journal-recall',
    surface: 'tool',
    schema: inputSchema,
    toolCategory: 'read_only',
    agentTypeDefault: 'complex',
    agentTypeOverridable: false,
    responseShapeName: 'BatchResponse',
  });
}

const RECALL_PROMPT = [
  JOURNAL_RECALL_ORIENTATION, '', JOURNAL_RECALL_PROCEDURE, '',
  JOURNAL_RECALL_SEVERITY, '', JOURNAL_RECALL_UNTRUSTED, '', JOURNAL_RECALL_EMPTY,
].join('\n');

export const toolConfig: ToolConfig<Input, JournalRecallBrief, InvestigateReportOutput> = {
  name: 'journal-recall',
  category: 'read_only',
  dispatchMode: 'parallel',
  dispatchModeOverridable: false,
  agentType: 'complex',
  briefSlot: journalRecallBriefSlot,
  buildTaskSpec: (brief: JournalRecallBrief, ctx: ExecutionContext) => ({
    prompt: `${RECALL_PROMPT}\n\nQuery: ${brief.query}`,
    readTarget: `Query: ${brief.query}`,
    agentType: 'complex' as const,
    reviewPolicy: 'none' as const,
    cwd: ctx.projectContext?.cwd ?? ctx.cwd,
    contextBlockIds: brief.contextBlockIds,
    tools: 'readonly',
    timeoutMs: ctx.config.defaults?.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS,
    sandboxPolicy: ctx.config.defaults?.sandboxPolicy ?? 'cwd-only',
    mainModel: ctx.mainModel ?? undefined,
  }),
  reportSchema: investigateReportSchema,
  headlineTemplate: journalRecallHeadlineTemplate,
};
