import { ToolSurfaceRegistry } from '../../tool-surface/tool-surface-registry.js';
import { inputSchema } from './schema.js';
import type { Input } from './schema.js';
import { qualityDebugTemplate } from '../../review/reviewer-engine.js';
import type { ToolConfig } from '../../lifecycle/tool-config-types.js';

export function registerDebug(registry: ToolSurfaceRegistry): void {
  registry.register({
    routeName: 'debug',
    httpMethod: 'POST',
    httpPath: '/debug',
    surface: 'tool',
    schema: inputSchema,
    toolCategory: 'read_only',
    agentTypeDefault: 'complex',
    agentTypeOverridable: false,
    responseShapeName: 'BatchResponse',
  });
}

export const toolConfig: ToolConfig<Input> = {
  name: 'debug',
  category: 'read_only',
  agentType: 'complex',
  briefSlot: (input) => [{ problem: input.problem, context: input.context, hypothesis: input.hypothesis, filePaths: input.filePaths, contextBlockIds: input.contextBlockIds }],
  buildTaskSpec: (brief, ctx) => ({
    prompt: `Debug this problem:\n\n${(brief as any).problem ?? ''}${(brief as any).context ? `\n\nContext: ${(brief as any).context}` : ''}${(brief as any).hypothesis ? `\n\nInitial hypothesis: ${(brief as any).hypothesis}` : ''}`,
    agentType: 'complex',
    reviewPolicy: 'quality_only' as const,
    cwd: ctx.projectContext?.cwd ?? ctx.cwd,
    contextBlockIds: (brief as any).contextBlockIds,
    tools: ctx.config.defaults?.tools ?? 'full',
    timeoutMs: ctx.config.defaults?.timeoutMs,
    maxCostUSD: ctx.config.defaults?.maxCostUSD,
    sandboxPolicy: ctx.config.defaults?.sandboxPolicy ?? 'cwd-only',
  }),
  reportSchema: { parse: (text) => { try { return JSON.parse(text); } catch { return text; } } },
  headlineTemplate: { compose: ({ taskBrief, status }) => `${status}: ${taskBrief}` },
  reviewTemplates: {
    qualityAP: qualityDebugTemplate,
  },
};
