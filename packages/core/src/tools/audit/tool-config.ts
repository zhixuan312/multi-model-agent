import { ToolSurfaceRegistry } from '../../tool-surface/tool-surface-registry.js';
import { inputSchema } from './schema.js';

export function registerAudit(registry: ToolSurfaceRegistry): void {
  registry.register({
    routeName: 'audit',
    httpMethod: 'POST',
    httpPath: '/audit',
    surface: 'tool',
    schema: inputSchema,
    toolCategory: 'read_only',
    agentTypeDefault: 'complex',
    agentTypeOverridable: false,
    responseShapeName: 'BatchResponse',
  });
}
