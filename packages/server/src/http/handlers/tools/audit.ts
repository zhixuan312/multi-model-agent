// packages/server/src/http/handlers/tools/audit.ts
import type { ServerResponse } from 'node:http';
import type { IncomingMessage } from 'node:http';
import * as audit from '@zhixuan92/multi-model-agent-core/tools/audit/schema';
import { executeAudit } from '@zhixuan92/multi-model-agent-core/lifecycle/executors/audit';
import { sendError, sendJson } from '../../errors.js';
import { asyncDispatch } from '../../async-dispatch.js';
import type { HandlerDeps } from '../../handler-deps.js';
import { emitRequestReceived } from '../../request-observability.js';
import type { RawHandler } from '../../router.js';
export function buildAuditHandler(deps: HandlerDeps): RawHandler {
  return async (_req: IncomingMessage, res: ServerResponse, _params: Record<string, string>, ctx) => {
    const parsed = audit.inputSchema.safeParse(ctx.body);
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
        route: 'audit',
        toolCategory: 'read_only',
        rawRequest: input,
      });
      sendJson(res, result.status, result.body);
      return;
    }

    // Legacy path (async-dispatch via executeAudit) — kept as fallback until
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
      tool: 'audit',
      projectCwd: cwd,
      blockIds,
      batchRegistry: deps.batchRegistry,
      projectContext: pc,
      deps,
      executor: async (executionCtx) => {
        return executeAudit(executionCtx, input);
      },
    });

    await emitRequestReceived({ config: deps.config, batchId, route: _req.url ?? '', parsed: input });

    sendJson(res, 202, { batchId, statusUrl });
  };
}
