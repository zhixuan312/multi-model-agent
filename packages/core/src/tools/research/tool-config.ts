import { ToolSurfaceRegistry } from '../../tool-surface/tool-surface-registry.js';
import { inputSchema } from './schema.js';
import type { ToolConfig } from '../../lifecycle/tool-config-types.js';
import type { ExecutionContext } from '../../lifecycle/lifecycle-context.js';
import { researchReportSchema, type ResearchReport } from '../../reporting/report-parser-slots/research-report.js';
import { researchHeadlineTemplate } from '../../reporting/headline-templates/research.js';
import { researchBriefSlot, type EnrichedResearchInput, type ResearchBrief } from './brief-slot.js';
import { DEFAULT_TASK_TIMEOUT_MS } from '../../config/schema.js';

export type { EnrichedResearchInput, ResearchBrief, ResolvedContextBlock } from './brief-slot.js';

export function registerResearch(registry: ToolSurfaceRegistry): void {
  registry.register({
    routeName: 'research',
    httpMethod: 'POST',
    httpPath: '/research',
    surface: 'tool',
    schema: inputSchema,
    toolCategory: 'read_only',
    agentTypeDefault: 'complex',
    agentTypeOverridable: false,
    responseShapeName: 'BatchResponse',
  });
}

export const toolConfig: ToolConfig<EnrichedResearchInput, ResearchBrief, ResearchReport> = {
  name: 'research',
  category: 'read_only',
  agentType: 'complex',
  briefSlot: researchBriefSlot,
  buildTaskSpec: (brief: ResearchBrief, ctx: ExecutionContext) => ({
    prompt: brief.compiledPrompt,
    parallelTarget: brief.compiledPrompt,
    agentType: 'complex' as const,
    reviewPolicy: 'none' as const,
    cwd: ctx.projectContext?.cwd ?? ctx.cwd,
    contextBlockIds: brief.contextBlockIds,
    tools: 'none' as const,
    timeoutMs: ctx.config.defaults?.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS,
    sandboxPolicy: ctx.config.defaults?.sandboxPolicy ?? 'cwd-only',
    mainModel: ctx.mainModel ?? undefined,
  }),
  reportSchema: researchReportSchema,
  headlineTemplate: researchHeadlineTemplate,
};
