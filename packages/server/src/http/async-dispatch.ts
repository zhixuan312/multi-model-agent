// packages/server/src/http/async-dispatch.ts
import { randomUUID } from 'node:crypto';
import type { BatchRegistry, ProjectContext } from '@zhixuan92/multi-model-agent-core';
import type { ExecutionContext } from '@zhixuan92/multi-model-agent-core/executors/types';
import type { HandlerDeps } from './handler-deps.js';
import { buildExecutionContext } from './execution-context.js';

export interface AsyncDispatchOptions<TResult> {
  tool: string;
  projectCwd: string;
  blockIds: string[];
  batchRegistry: BatchRegistry;
  projectContext: ProjectContext;
  deps: HandlerDeps;
  /**
   * The async function that does the real work. Receives the ExecutionContext
   * and the pre-allocated batchId.
   */
  executor: (ctx: ExecutionContext, batchId: string) => Promise<TResult>;
}

export interface AsyncDispatchResult {
  batchId: string;
  statusUrl: string;
}

/**
 * Registers a new batch as 'pending', schedules the executor via setImmediate,
 * and returns immediately with { batchId, statusUrl }.
 *
 * On success: calls batchRegistry.complete(batchId, result).
 * On failure: calls batchRegistry.fail(batchId, { code, message, stack }).
 *
 * IMPORTANT: Does NOT maintain a manual activeBatches counter.
 * Use BatchRegistry.countActiveForProject(cwd) as the truth source.
 */
export function asyncDispatch<TResult>(
  opts: AsyncDispatchOptions<TResult>,
): AsyncDispatchResult {
  const batchId = randomUUID();
  const { batchRegistry, projectContext, deps, tool, projectCwd, blockIds } = opts;

  // Register entry as 'pending' before scheduling executor
  batchRegistry.register({
    batchId,
    projectCwd,
    tool,
    state: 'pending',
    startedAt: Date.now(),
    stateChangedAt: Date.now(),
    blockIds,
    blocksReleased: false,
  });

  // Build execution context for this batch
  const ctx = buildExecutionContext(deps, projectContext, batchId);

  // Schedule executor asynchronously — do not await here
  setImmediate(() => {
    void (async () => {
      try {
        deps.logger.taskStarted({ batchId, taskIndex: 0 });
        const result = await opts.executor(ctx, batchId);
        batchRegistry.complete(batchId, result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : undefined;
        batchRegistry.fail(batchId, {
          code: 'executor_error',
          message,
          ...(stack !== undefined && { stack }),
        });
      }
    })();
  });

  return {
    batchId,
    statusUrl: `/batch/${batchId}`,
  };
}
