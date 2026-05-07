import { ToolSurfaceRegistry } from '../../tool-surface/tool-surface-registry.js';
import { inputSchema } from './schema.js';
import type { Input } from './schema.js';
import { qualityInvestigateTemplate } from '../../review/reviewer-engine.js';
import type { ToolConfig } from '../../lifecycle/tool-config-types.js';

export function registerInvestigate(registry: ToolSurfaceRegistry): void {
  registry.register({
    routeName: 'investigate',
    httpMethod: 'POST',
    httpPath: '/investigate',
    surface: 'tool',
    schema: inputSchema,
    toolCategory: 'read_only',
    agentTypeDefault: 'complex',
    agentTypeOverridable: false,
    responseShapeName: 'BatchResponse',
  });
}

export const toolConfig: ToolConfig<Input> = {
  name: 'investigate',
  category: 'read_only',
  agentType: 'complex',
  briefSlot: (input) => [{ question: input.question, filePaths: input.filePaths, contextBlockIds: input.contextBlockIds, tools: input.tools }],
  buildTaskSpec: (brief, ctx) => ({
    prompt: `Investigate: ${(brief as any).question ?? ''}`,
    agentType: 'complex',
    reviewPolicy: 'quality_only' as const,
    cwd: ctx.projectContext?.cwd ?? ctx.cwd,
    contextBlockIds: (brief as any).contextBlockIds,
    filePaths: (brief as any).filePaths,
    tools: (brief as any).tools ?? ctx.config.defaults?.tools ?? 'full',
    timeoutMs: ctx.config.defaults?.timeoutMs,
    maxCostUSD: ctx.config.defaults?.maxCostUSD,
    sandboxPolicy: ctx.config.defaults?.sandboxPolicy ?? 'cwd-only',
  }),
  reportSchema: { parse: (text) => { try { return JSON.parse(text); } catch { return text; } } },
  headlineTemplate: { compose: ({ taskBrief, status }) => `${status}: ${taskBrief}` },
  reviewTemplates: {
    qualityAP: qualityInvestigateTemplate,
  },
};
