// packages/server/src/http/execution-context.ts
import { createProvider, composeRunningHeadline } from '@zhixuan92/multi-model-agent-core';
import type { ProjectContext, HeartbeatTickInfo } from '@zhixuan92/multi-model-agent-core';
import type { ExecutionContext, ClarificationProposal } from '@zhixuan92/multi-model-agent-core/executors/types';
import type { HandlerDeps } from './handler-deps.js';

/**
 * Builds the ExecutionContext passed to every executor.
 *
 * awaitClarification wires to the BatchRegistry clarification flow:
 * 1. Sets entry.resolveClarification BEFORE calling requestClarification
 *    (order matters — requestClarification changes state; resolver must be
 *    registered first so resumeFromClarification can call it later).
 * 2. Returns a Promise that resolves when resumeFromClarification is called
 *    by the POST /batch/:id/clarify handler (Phase 7).
 */
export function buildExecutionContext(
  deps: HandlerDeps,
  pc: ProjectContext,
  batchId: string,
): ExecutionContext {
  const recordHeartbeat = (tick: HeartbeatTickInfo) => {
    const entry = deps.batchRegistry.get(tick.batchId || batchId);
    if (!entry) return;
    entry.lastHeartbeatAt = Date.now();
    const headline = composeRunningHeadline({
      tasksTotal: entry.tasksTotal ?? 1,
      tasksStarted: entry.tasksStarted ?? 0,
      tasksCompleted: entry.tasksCompleted ?? 0,
      startedAt: entry.startedAt,
      nowMs: Date.now(),
      lastHeartbeatAt: entry.lastHeartbeatAt,
      running: entry.running ?? [],
    });
    deps.batchRegistry.updateRunningHeadline(tick.batchId || batchId, headline);
  };

  return {
    projectContext: pc,
    config: deps.config,
    logger: deps.logger,
    contextBlockStore: pc.contextBlocks,
    providerFactory: (profile: string) => createProvider(profile as 'standard' | 'complex', deps.config),
    parentModel: process.env['PARENT_MODEL_NAME'],
    onProgress: undefined,
    batchId,
    recordHeartbeat,
    awaitClarification: async (proposal: ClarificationProposal) => {
      return new Promise<{ interpretation: string }>((resolve) => {
        const entry = deps.batchRegistry.get(batchId);
        if (entry) {
          // Register resolver BEFORE transitioning state so resumeFromClarification
          // can call it immediately if it races ahead.
          entry.resolveClarification = (interpretation: string) => resolve({ interpretation });
        }
        deps.batchRegistry.requestClarification(batchId, proposal.interpretation);
      });
    },
  };
}
