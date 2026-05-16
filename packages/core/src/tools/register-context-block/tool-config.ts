import { ToolSurfaceRegistry } from '../../tool-surface/tool-surface-registry.js';
import { inputSchema } from './schema.js';
import type { RegisterContextBlockInput } from './schema.js';
import type { ToolConfig } from '../../lifecycle/tool-config-types.js';

export function registerContextBlock(registry: ToolSurfaceRegistry): void {
  registry.register({
    routeName: 'register_context_block',
    httpMethod: 'POST',
    httpPath: '/context-blocks',
    surface: 'control',
    schema: inputSchema,
    toolCategory: 'assist',
    agentTypeDefault: 'standard',
    agentTypeOverridable: false,
    responseShapeName: 'ContextBlockResponse',
  });
}

export const toolConfig: ToolConfig<RegisterContextBlockInput> = {
  name: 'register_context_block',
  category: 'assist',
  agentType: 'standard',
  briefSlot: (input) => [{ type: input.type, description: input.description, body: input.body }],
  buildTaskSpec: (brief, ctx) => ({
    prompt: `Register context block: ${(brief as any).description ?? ''}\n\n${(brief as any).body ?? ''}`,
    agentType: 'standard',
    reviewPolicy: 'none' as const,
    cwd: ctx.projectContext?.cwd ?? ctx.cwd,
    tools: ctx.config.defaults?.tools ?? 'full',
    timeoutMs: ctx.config.defaults?.timeoutMs,
    sandboxPolicy: ctx.config.defaults?.sandboxPolicy ?? 'cwd-only',
  }),
  reportSchema: { parse: (text) => { try { return JSON.parse(text); } catch { return text; } } },
  headlineTemplate: { compose: ({ taskBrief, status }) => `${status}: ${taskBrief}` },
};
