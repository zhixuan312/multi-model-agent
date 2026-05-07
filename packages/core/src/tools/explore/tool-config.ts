import { ToolSurfaceRegistry } from '../../tool-surface/tool-surface-registry.js';
import { inputSchema } from './schema.js';

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
