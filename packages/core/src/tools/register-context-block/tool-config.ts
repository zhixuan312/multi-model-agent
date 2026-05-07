import { ToolSurfaceRegistry } from '../../tool-surface/tool-surface-registry.js';
import { inputSchema } from './schema.js';

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
