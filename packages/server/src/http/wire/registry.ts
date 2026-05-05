import { z } from 'zod';
import { ToolSurfaceRegistry } from '@zhixuan92/multi-model-agent-core';

export function registerDelegate(registry: ToolSurfaceRegistry): void {
  registry.register({
    routeName: 'delegate',
    schema: z.object({
      tasks: z.array(z.object({
        brief: z.string(),
        cwd: z.string().optional(),
        agentType: z.enum(['standard', 'complex']).optional(),
        reviewPolicy: z.enum(['full', 'quality_only', 'diff_only', 'none']).optional(),
        contextBlockIds: z.array(z.string()).optional(),
      })),
    }),
    toolCategory: 'artifact_producing',
    agentTypeDefault: 'standard',
    agentTypeOverridable: true,
    responseShapeName: 'BatchResponse',
  });
}
