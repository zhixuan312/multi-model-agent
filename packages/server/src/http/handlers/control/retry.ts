// packages/server/src/http/handlers/control/retry.ts
//
// CONTROL retry route — POST /control/retry. Validates the batch
// synchronously against the per-project cache; returns 404 unknown_batch
// if the id has expired. Always uses the direct executor (never the
// LifecycleDispatcher).
//
// SEE ALSO: handlers/tools/retry.ts (the public /retry route used by
// the mma-retry skill). Both endpoints share the same toolConfig and
// executeTask import; they differ in dispatch policy and pre-validation.
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

    const reserveResult = deps.projectRegistry.reserveProject(cwd);
    if (!reserveResult.ok) {
      sendError(res, 503, reserveResult.error, reserveResult.message);
      return;
    }
    const pc = reserveResult.projectContext;
    pc.lastActivityAt = Date.now();
    deps.projectRegistry.cancelReservation(cwd);

    const entry = pc.batchCache.get(input.batchId);
    if (!entry) {
      sendError(res, 404, 'not_found', `Batch ${input.batchId} not found`);
      return;
    }

    const { batchId, statusUrl } = asyncDispatch({
      tool: 'retry',
      projectCwd: cwd,
      blockIds: [],
      batchRegistry: deps.batchRegistry,
      projectContext: pc,
      deps,
      caller: { client: ctx.callerClient, mainModel: ctx.mainModel },
      executor: async (executionCtx) => {
        const batchCache = executionCtx.projectContext!.batchCache;
        const batch = batchCache.get(input.batchId)!;
        const subset = input.taskIndices.map((i) => batch.tasks[i]);
        const retryBatchId = batchCache.remember(executionCtx.batchId!, subset);

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
      },
    });

    sendJson(res, 202, { batchId, statusUrl });
  };
}
