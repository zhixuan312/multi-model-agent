import { ToolSurfaceRegistry } from '../../tool-surface/tool-surface-registry.js';
import { inputSchema } from './schema.js';

export function registerInvestigate(registry: ToolSurfaceRegistry): void {
  registry.register({
    routeName: 'investigate',
    httpMethod: 'POST',
    httpPath: '/investigate',
    surface: 'tool',
    schema: inputSchema,
    toolCategory: 'read_only',
    agentTypeDefault: 'complex',
    agentTypeOverridable: false,
    responseShapeName: 'BatchResponse',
  });
}
