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
  briefSlot: (input) => [{ currentContext: input.currentContext, explorationQuestion: input.explorationQuestion, anchors: input.anchors, contextBlockIds: input.contextBlockIds }],
  reportSchema: { parse: (text) => { try { return JSON.parse(text); } catch { return text; } } },
  headlineTemplate: { compose: ({ taskBrief, status }) => `${status}: ${taskBrief}` },
};
