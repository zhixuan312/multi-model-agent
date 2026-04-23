// packages/server/src/http/execution-context.ts
import { createProvider } from '@zhixuan92/multi-model-agent-core';
import type { ProjectContext } from '@zhixuan92/multi-model-agent-core';
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
  return {
    projectContext: pc,
    config: deps.config,
    logger: deps.logger,
    contextBlockStore: pc.contextBlocks,
    providerFactory: (profile: string) => createProvider(profile as 'standard' | 'complex', deps.config),
    parentModel: process.env['PARENT_MODEL_NAME'],
    onProgress: undefined,
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
