import { ToolSurfaceRegistry } from '../../tool-surface/tool-surface-registry.js';
import { inputSchema } from './schema.js';

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
