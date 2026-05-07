import { ToolSurfaceRegistry } from '../../tool-surface/tool-surface-registry.js';
import { inputSchema } from './schema.js';
import type { Input } from './schema.js';
import { qualityReviewTemplate } from '../../review/reviewer-engine.js';
import type { ToolConfig } from '../../lifecycle/tool-config-types.js';

export function registerReview(registry: ToolSurfaceRegistry): void {
  registry.register({
    routeName: 'review',
    httpMethod: 'POST',
    httpPath: '/review',
    surface: 'tool',
    schema: inputSchema,
    toolCategory: 'read_only',
    agentTypeDefault: 'complex',
    agentTypeOverridable: false,
    responseShapeName: 'BatchResponse',
  });
}

export const toolConfig: ToolConfig<Input> = {
  name: 'review',
  category: 'read_only',
  briefSlot: (input) => [{ code: input.code, focus: input.focus, filePaths: input.filePaths, contextBlockIds: input.contextBlockIds }],
  reportSchema: { parse: (text) => { try { return JSON.parse(text); } catch { return text; } } },
  headlineTemplate: { compose: ({ taskBrief, status }) => `${status}: ${taskBrief}` },
  reviewTemplates: {
    qualityAP: qualityReviewTemplate,
  },
};
