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
  briefSlot: (input) => [{ type: input.type, description: input.description, body: input.body }],
  reportSchema: { parse: (text) => { try { return JSON.parse(text); } catch { return text; } } },
  headlineTemplate: { compose: ({ taskBrief, status }) => `${status}: ${taskBrief}` },
};
