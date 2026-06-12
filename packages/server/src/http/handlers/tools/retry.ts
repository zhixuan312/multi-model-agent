// packages/server/src/http/handlers/tools/retry.ts
//
// PUBLIC retry route — POST /retry. Goes through the LifecycleDispatcher;
// missing-batch and invalid task cases return 202 and surface the error
// asynchronously inside the batch result. This is the route called by
// the `mma-retry` skill and end-user clients.
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
        // Surface a clean error if the prior batch's goal is gone; buildTaskSpec
        // also throws goal_not_found, but this gives the friendlier message.
        if (!batchCache.get(input.batchId)) {
          throw new Error(
            `batch "${input.batchId}" is unknown or expired — re-dispatch via delegate / execute-plan`,
          );
        }
        batchCache.touch(input.batchId);
        // Goal mode: executeTask pulls the stored goal (via the retry tool-config's
        // buildTaskSpec) and re-fires the whole goal-set against the current HEAD.
        return executeTask(toolConfig, executionCtx, input);
      },
    });

    sendJson(res, 202, { batchId, statusUrl });
  };
}
