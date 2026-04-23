// packages/mcp/src/execution-context.ts
// Temporary scaffolding — deleted in Phase 2 along with the MCP entry point.
// Bridges the MCP server's runtime objects into the ExecutionContext shape
// required by the core executors.
import type { MultiModelConfig, DiagnosticLogger, ProjectContext, ContextBlockStore } from '@zhixuan92/multi-model-agent-core';
import type { ExecutionContext } from '@zhixuan92/multi-model-agent-core/executors/index';

export function buildExecutionContextForMcp(
  config: MultiModelConfig,
  logger: DiagnosticLogger,
  projectContext: ProjectContext,
  contextBlockStore: ContextBlockStore,
): ExecutionContext {
  return {
    projectContext,
    config,
    logger,
    contextBlockStore,
  };
}
