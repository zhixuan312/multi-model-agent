import { ToolSurfaceRegistry } from '../../tool-surface/tool-surface-registry.js';
import { inputSchema } from './schema.js';

export function registerRetry(registry: ToolSurfaceRegistry): void {
  registry.register({
    routeName: 'retry_tasks',
    httpMethod: 'POST',
    httpPath: '/retry',
    surface: 'tool',
    schema: inputSchema,
    toolCategory: 'assist',
    agentTypeDefault: 'standard',
    agentTypeOverridable: true,
    responseShapeName: 'BatchResponse',
  });
}
