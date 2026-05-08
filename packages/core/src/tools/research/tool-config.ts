import { ToolSurfaceRegistry } from '../../tool-surface/tool-surface-registry.js';
import { inputSchema } from './schema.js';
import type { Input } from './schema.js';
import type { ToolConfig } from '../../lifecycle/tool-config-types.js';
import type { ExecutionContext } from '../../lifecycle/lifecycle-context.js';
import { researchReportSchema, type ResearchReport } from '../../reporting/report-parser-slots/research-report.js';
import { researchHeadlineTemplate } from '../../reporting/headline-templates/research.js';
import { compileResearch, type ResolvedContextBlock } from '../../intake/brief-compiler-slots/research.js';
import { DEFAULT_TASK_TIMEOUT_MS } from '../../config/schema.js';

export function registerResearch(registry: ToolSurfaceRegistry): void {
  registry.register({
    routeName: 'research',
    httpMethod: 'POST',
    httpPath: '/research',
    surface: 'tool',
    schema: inputSchema,
    toolCategory: 'research',
    agentTypeDefault: 'complex',
    agentTypeOverridable: false,
    responseShapeName: 'BatchResponse',
  });
}

export interface EnrichedResearchInput extends Input {
  resolvedContextBlocks: ResolvedContextBlock[];
}

export interface ResearchBrief {
  compiledPrompt: string;
  contextBlockIds: string[];
}

export const toolConfig: ToolConfig<EnrichedResearchInput, ResearchBrief, ResearchReport> = {
  name: 'research',
  category: 'research',
  agentType: 'complex',
  briefSlot: (input: EnrichedResearchInput): ResearchBrief[] => {
    const { task } = compileResearch(
      input,
      input.resolvedContextBlocks,
      // cwd is filled in by buildTaskSpec via ExecutionContext
      '',
      {
        userSources: [],
        hasBrave: false,
      },
    );
    return [{
      compiledPrompt: task.prompt,
      contextBlockIds: input.contextBlockIds ?? [],
    }];
  },
  buildTaskSpec: (brief: ResearchBrief, ctx: ExecutionContext) => ({
    prompt: brief.compiledPrompt,
    agentType: 'complex' as const,
    reviewPolicy: 'none' as const,
    cwd: ctx.projectContext?.cwd ?? ctx.cwd,
    contextBlockIds: brief.contextBlockIds,
    tools: 'readonly' as const,
    timeoutMs: ctx.config.defaults?.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS,
    maxCostUSD: ctx.config.defaults?.maxCostUSD ?? 10,
    sandboxPolicy: ctx.config.defaults?.sandboxPolicy ?? 'cwd-only',
    mainModel: ctx.mainModel ?? undefined,
  }),
  reportSchema: researchReportSchema,
  headlineTemplate: researchHeadlineTemplate,
};
