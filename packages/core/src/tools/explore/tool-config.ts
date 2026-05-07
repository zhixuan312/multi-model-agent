import { ToolSurfaceRegistry } from '../../tool-surface/tool-surface-registry.js';
import { inputSchema } from './schema.js';
import type { Input } from './schema.js';
import type { ToolConfig } from '../../lifecycle/tool-config-types.js';
import { exploreReportSchema, type ExploreReport } from '../../reporting/report-parser-slots/explore-report.js';
import { exploreHeadlineTemplate } from '../../reporting/headline-templates/explore.js';

export function registerExplore(registry: ToolSurfaceRegistry): void {
  registry.register({
    routeName: 'explore',
    httpMethod: 'POST',
    httpPath: '/explore',
    surface: 'tool',
    schema: inputSchema,
    toolCategory: 'research',
    agentTypeDefault: 'complex',
    agentTypeOverridable: false,
    responseShapeName: 'BatchResponse',
  });
}

export const toolConfig: ToolConfig<Input, Input, ExploreReport> = {
  name: 'explore',
  category: 'research',
  agentType: 'complex',
  briefSlot: (input) => [input],
  buildTaskSpec: (brief, ctx) => ({
    prompt: `Explore: ${brief.explorationQuestion ?? ''}\n\nContext: ${brief.currentContext ?? ''}`,
    agentType: 'complex',
    reviewPolicy: 'none' as const,
    cwd: ctx.projectContext?.cwd ?? ctx.cwd,
    contextBlockIds: brief.contextBlockIds,
    tools: ctx.config.defaults?.tools ?? 'full',
    timeoutMs: ctx.config.defaults?.timeoutMs,
    maxCostUSD: ctx.config.defaults?.maxCostUSD,
    sandboxPolicy: ctx.config.defaults?.sandboxPolicy ?? 'cwd-only',
  }),
  reportSchema: exploreReportSchema,
  headlineTemplate: exploreHeadlineTemplate,
};
