// packages/mcp/src/execution-context.ts
// Temporary scaffolding — deleted in Phase 2 along with the MCP entry point.
// Bridges the MCP server's runtime objects into the ExecutionContext shape
// required by the core executors.
import type { MultiModelConfig, DiagnosticLogger, ProjectContext, ContextBlockStore } from '@zhixuan92/multi-model-agent-core';
import { InMemoryContextBlockStore, BatchCache, ClarificationStore, createProvider } from '@zhixuan92/multi-model-agent-core';
import type { ExecutionContext } from '@zhixuan92/multi-model-agent-core/executors/index';

/**
 * MCP does not support a promise-based clarification flow — clarifications flow through
 * the response envelope and clients poll. This stub rejects to make the limitation explicit.
 */
function mcpAwaitClarificationStub(): Promise<never> {
  return Promise.reject(
    new Error(
      'awaitClarification is not supported in MCP context; clarifications flow through the response envelope',
    ),
  );
}

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
    providerFactory: (profile: string) => createProvider(profile as import('@zhixuan92/multi-model-agent-core').AgentType, config),
    onProgress: undefined,
    awaitClarification: mcpAwaitClarificationStub,
    parentModel: process.env.PARENT_MODEL_NAME || config.defaults?.parentModel || undefined,
  };
}

/**
 * Build a minimal ExecutionContext for specialized tools (audit, review, verify, debug,
 * execute-plan) that don't need batchCache or clarifications. Used when `projectContext`
 * is not available (e.g. in tests that only pass `config + logger + contextBlockStore`).
 */
export function buildMinimalExecutionContext(
  config: MultiModelConfig,
  logger: DiagnosticLogger,
  contextBlockStore?: ContextBlockStore,
): ExecutionContext {
  const store = contextBlockStore ?? new InMemoryContextBlockStore();
  const minimalProjectContext: ProjectContext = {
    cwd: process.cwd(),
    contextBlocks: store as InMemoryContextBlockStore,
    batchCache: new BatchCache(),
    clarifications: new ClarificationStore(),
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    activeSessions: new Set<string>(),
    activeRequests: 0,
    pendingReservations: 0,
  };
  return {
    projectContext: minimalProjectContext,
    config,
    logger,
    contextBlockStore: store,
    providerFactory: (profile: string) => createProvider(profile as import('@zhixuan92/multi-model-agent-core').AgentType, config),
    onProgress: undefined,
    awaitClarification: mcpAwaitClarificationStub,
    parentModel: process.env.PARENT_MODEL_NAME || config.defaults?.parentModel || undefined,
  };
}
