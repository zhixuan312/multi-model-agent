import { ToolSurfaceRegistry } from '../../tool-surface/tool-surface-registry.js';
import { inputSchema } from './schema.js';
import type { Input } from './schema.js';
import type { ToolConfig } from '../../lifecycle/tool-config-types.js';

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

export const toolConfig: ToolConfig<Input> = {
  name: 'explore',
  category: 'research',
  agentType: 'complex',
  briefSlot: (input) => [{ currentContext: input.currentContext, explorationQuestion: input.explorationQuestion, anchors: input.anchors, contextBlockIds: input.contextBlockIds }],
  buildTaskSpec: (brief, ctx) => ({
    prompt: `Explore: ${(brief as any).explorationQuestion ?? ''}\n\nContext: ${(brief as any).currentContext ?? ''}`,
    agentType: 'complex',
    reviewPolicy: 'none' as const,
    cwd: ctx.projectContext?.cwd ?? ctx.cwd,
    contextBlockIds: (brief as any).contextBlockIds,
    tools: ctx.config.defaults?.tools ?? 'full',
    timeoutMs: ctx.config.defaults?.timeoutMs,
    maxCostUSD: ctx.config.defaults?.maxCostUSD,
    sandboxPolicy: ctx.config.defaults?.sandboxPolicy ?? 'cwd-only',
  }),
  reportSchema: { parse: (text) => { try { return JSON.parse(text); } catch { return text; } } },
  headlineTemplate: { compose: ({ taskBrief, status }) => `${status}: ${taskBrief}` },
};
