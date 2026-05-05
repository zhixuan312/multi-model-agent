// packages/server/src/http/handlers/tools/execute-plan.ts
import type { ServerResponse } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { executePlanInputSchema } from '../../wire/execute-plan-wire.js';
import type { ExecutePlanWireInput } from '../../wire/execute-plan-wire.js';
import { executeExecutePlan } from '@zhixuan92/multi-model-agent-core/executors/execute-plan';
import { sendError, sendJson } from '../../errors.js';
import { asyncDispatch } from '../../async-dispatch.js';
import type { HandlerDeps } from '../../handler-deps.js';
import { emitRequestReceived } from '../../request-observability.js';
import type { RawHandler } from '../../router.js';

export function buildExecutePlanHandler(deps: HandlerDeps): RawHandler {
  return async (_req: IncomingMessage, res: ServerResponse, _params: Record<string, string>, ctx) => {
    const parsed = executePlanInputSchema.safeParse(ctx.body);
    if (!parsed.success) {
      sendError(res, 400, 'invalid_request', 'Request body validation failed', {
        fieldErrors: parsed.error.flatten(),
      });
      return;
    }

    const input: ExecutePlanWireInput = parsed.data;

    // v4.0 lifecycle path: when a RouteDispatcher is wired, dispatch through
    // the new lifecycle.
    if (deps.routeDispatcher) {
      const result = await deps.routeDispatcher.dispatch({
        route: 'execute_plan',
        toolCategory: 'artifact_producing',
        rawRequest: input,
      });
      sendJson(res, result.status, result.body);
      return;
    }

    // Legacy path (async-dispatch via executeExecutePlan) — kept as fallback until
    // server.ts wires routeDispatcher for all tool routes.
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
      tool: 'execute-plan',
      projectCwd: cwd,
      blockIds: [],
      batchRegistry: deps.batchRegistry,
      projectContext: pc,
      deps,
      executor: async (executionCtx) => {
        // Map new wire input shape to legacy executor input shape
        return executeExecutePlan(executionCtx, {
          tasks: input.taskDescriptors,
          filePaths: input.filePaths,
        });
      },
    });

    await emitRequestReceived({ config: deps.config, batchId, route: _req.url ?? '', parsed: input });

    sendJson(res, 202, { batchId, statusUrl });
  };
}
