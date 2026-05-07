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
  briefSlot: (input) => [{ problem: input.problem, context: input.context, hypothesis: input.hypothesis, filePaths: input.filePaths, contextBlockIds: input.contextBlockIds }],
  reportSchema: { parse: (text) => { try { return JSON.parse(text); } catch { return text; } } },
  headlineTemplate: { compose: ({ taskBrief, status }) => `${status}: ${taskBrief}` },
  reviewTemplates: {
    qualityAP: qualityDebugTemplate,
  },
};
