import type { ExecutionContext, ExecutionContextInput } from './types.js';

export function buildExecutionContext(input: ExecutionContextInput): ExecutionContext {
  if (!input.projectContext) throw new Error('buildExecutionContext: projectContext required');
  if (!input.config) throw new Error('buildExecutionContext: config required');
  if (!input.logger) throw new Error('buildExecutionContext: logger required');
  if (!input.contextBlockStore) throw new Error('buildExecutionContext: contextBlockStore required');
  return {
    projectContext: input.projectContext,
    config: input.config,
    logger: input.logger,
    contextBlockStore: input.contextBlockStore,
    ...(input.parentModel !== undefined && { parentModel: input.parentModel }),
    ...(input.batchId !== undefined && { batchId: input.batchId }),
    ...(input.recordHeartbeat !== undefined && { recordHeartbeat: input.recordHeartbeat }),
  };
}
