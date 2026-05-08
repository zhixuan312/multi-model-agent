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
  /** Operator-configured source descriptors (research.userSources). */
  userSources: readonly string[];
  /** True iff research.brave.apiKeys is non-empty (drives the prompt branch
   *  that says "escalate to web_search"). */
  hasBrave: boolean;
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
    // cwd is irrelevant to prompt compilation (research is external-only); the
    // generic executor's buildTaskSpec sets the cwd on the TaskSpec from
    // ExecutionContext.
    const { task } = compileResearch(input, input.resolvedContextBlocks, '', {
      userSources: input.userSources,
      hasBrave: input.hasBrave,
    });
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
