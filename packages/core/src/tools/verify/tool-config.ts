import { ToolSurfaceRegistry } from '../../tool-surface/tool-surface-registry.js';
import { inputSchema } from './schema.js';
import type { Input } from './schema.js';
import { qualityVerifyTemplate } from '../../review/reviewer-engine.js';
import type { ToolConfig } from '../../lifecycle/tool-config-types.js';

export function registerVerify(registry: ToolSurfaceRegistry): void {
  registry.register({
    routeName: 'verify',
    httpMethod: 'POST',
    httpPath: '/verify',
    surface: 'tool',
    schema: inputSchema,
    toolCategory: 'read_only',
    agentTypeDefault: 'complex',
    agentTypeOverridable: false,
    responseShapeName: 'BatchResponse',
  });
}

export const toolConfig: ToolConfig<Input> = {
  name: 'verify',
  category: 'read_only',
  briefSlot: (input) => [{ checklist: input.checklist, work: input.work, filePaths: input.filePaths, contextBlockIds: input.contextBlockIds }],
  reportSchema: { parse: (text) => { try { return JSON.parse(text); } catch { return text; } } },
  headlineTemplate: { compose: ({ taskBrief, status }) => `${status}: ${taskBrief}` },
  reviewTemplates: {
    qualityAP: qualityVerifyTemplate,
  },
};
