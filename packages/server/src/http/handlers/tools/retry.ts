// packages/server/src/http/handlers/tools/retry.ts
//
// PUBLIC retry route — POST /retry. Goes through the LifecycleDispatcher
// when the original batch's toolCategory is recoverable; missing-batch
// and invalid-category cases return 202 and surface the error
// asynchronously inside the batch result. This is the route called by
// the `mma-retry` skill and end-user clients.
//
// SEE ALSO: handlers/control/retry.ts is the protocol-level twin
// registered at /control/retry — same executor, but synchronous batch
// validation (404s when the batchId is unknown) and no dispatcher path.
import type { ServerResponse } from 'node:http';
import type { IncomingMessage } from 'node:http';
import * as retry from '@zhixuan92/multi-model-agent-core/tools/retry/schema';
import { executeTask } from '@zhixuan92/multi-model-agent-core/lifecycle/task-executor';
import { toolConfig } from '@zhixuan92/multi-model-agent-core/tools/retry/tool-config';
import { sendError, sendJson } from '../../errors.js';
import { asyncDispatch } from '../../async-dispatch.js';
import type { HandlerDeps } from '../../handler-deps.js';
import type { RawHandler } from '../../types.js';

export function buildRetryHandler(deps: HandlerDeps): RawHandler {
  return async (_req: IncomingMessage, res: ServerResponse, _params: Record<string, string>, ctx) => {
    const parsed = retry.inputSchema.safeParse(ctx.body);
    if (!parsed.success) {
      sendError(res, 400, 'invalid_request', 'Request body validation failed', {
        fieldErrors: parsed.error.flatten(),
      });
      return;
    }

    const input = parsed.data;
    const cwd = ctx.cwd!;

    // Resolve original batch's toolCategory for dispatcher budget selection.
    let originalToolCategory: 'artifact_producing' | 'read_only' | 'research' | undefined;
    if (deps.routeDispatcher) {
      const original = deps.batchRegistry.get(input.batchId);
      if (
        original
        && original.toolCategory
        && (original.toolCategory as string) !== 'assist'
      ) {
        originalToolCategory = original.toolCategory as typeof originalToolCategory;
      }
    }

    const reserveResult = deps.projectRegistry.reserveProject(cwd);
    if (!reserveResult.ok) {
      sendError(res, 503, reserveResult.error, reserveResult.message);
      return;
    }
    const pc = reserveResult.projectContext;
    pc.lastActivityAt = Date.now();
    deps.projectRegistry.cancelReservation(cwd);

    const { batchId, statusUrl } = asyncDispatch({
      tool: 'retry',
      projectCwd: cwd,
      blockIds: [],
      batchRegistry: deps.batchRegistry,
      projectContext: pc,
      deps,
      caller: { client: ctx.callerClient },
      executor: async (executionCtx) => {
        const callExecutor = async () => {
          const batchCache = executionCtx.projectContext!.batchCache;

          const batch = batchCache.get(input.batchId);
          if (!batch) {
            throw new Error(
              `batch "${input.batchId}" is unknown or expired — re-dispatch with full task specs via delegate_tasks`,
            );
          }
          batchCache.touch(input.batchId);
          for (const i of input.taskIndices) {
            if (i < 0 || i >= batch.tasks.length) {
              throw new Error(
                `index ${i} is out of range for batch ${input.batchId} (size ${batch.tasks.length})`,
              );
            }
          }
          const subset = input.taskIndices.map((i) => batch.tasks[i]);
          if (!executionCtx.batchId) throw new Error('retry requires batchId');
          const retryBatchId = batchCache.remember(executionCtx.batchId, subset);

          let retryAborted = false;
          let results: import('@zhixuan92/multi-model-agent-core').RunResult[] = [];
          try {
            const result = await executeTask(toolConfig, executionCtx, input);
            results = Array.isArray(result.results) ? result.results : [];
            return result;
          } catch (err) {
            retryAborted = true;
            throw err;
          } finally {
            if (retryAborted) {
              try { batchCache.abort(retryBatchId); } catch { /* already terminal */ }
            } else {
              try { batchCache.complete(retryBatchId, results); } catch { /* already terminal */ }
            }
          }
        };

        if (deps.routeDispatcher && originalToolCategory) {
          const result = await deps.routeDispatcher.dispatch({
            route: 'retry',
            toolCategory: originalToolCategory,
            rawRequest: { batchId: input.batchId, retryableFor: input.taskIndices, cwd },
            executor: () => callExecutor(),
          });
          return result.body;
        }
        return callExecutor();
      },
    });

    sendJson(res, 202, { batchId, statusUrl });
  };
}
