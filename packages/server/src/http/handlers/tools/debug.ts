// packages/server/src/http/handlers/tools/debug.ts
import type { ServerResponse } from 'node:http';
import type { IncomingMessage } from 'node:http';
import * as debug from '@zhixuan92/multi-model-agent-core/tools/debug/schema';
import { executeDebug } from '@zhixuan92/multi-model-agent-core/lifecycle/executors/debug';
import { sendError, sendJson } from '../../errors.js';
import { asyncDispatch } from '../../async-dispatch.js';
import type { HandlerDeps } from '../../handler-deps.js';
import { emitRequestReceived } from '../../request-observability.js';
import type { RawHandler } from '../../types.js';
export function buildDebugHandler(deps: HandlerDeps): RawHandler {
  return async (_req: IncomingMessage, res: ServerResponse, _params: Record<string, string>, ctx) => {
    const parsed = debug.inputSchema.safeParse(ctx.body);
    if (!parsed.success) {
      sendError(res, 400, 'invalid_request', 'Request body validation failed', {
        fieldErrors: parsed.error.flatten(),
      });
      return;
    }

    const input = parsed.data;

    // v4.0 lifecycle path: when a RouteDispatcher is wired, dispatch through
    // the new lifecycle.
    if (deps.routeDispatcher) {
      const result = await deps.routeDispatcher.dispatch({
        route: 'debug',
        toolCategory: 'read_only',
        rawRequest: input,
      });
      sendJson(res, result.status, result.body);
      return;
    }

    // Legacy path (async-dispatch via executeDebug) — kept as fallback until
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

    const blockIds = input.contextBlockIds ?? [];
    const { batchId, statusUrl } = asyncDispatch({
      tool: 'debug',
      projectCwd: cwd,
      blockIds,
      batchRegistry: deps.batchRegistry,
      projectContext: pc,
      deps,
      executor: async (executionCtx) => {
        return executeDebug(executionCtx, input);
      },
    });

    await emitRequestReceived({ config: deps.config, batchId, route: _req.url ?? '', parsed: input });

    sendJson(res, 202, { batchId, statusUrl });
  };
}
