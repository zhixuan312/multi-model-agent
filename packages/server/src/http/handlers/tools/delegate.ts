// packages/server/src/http/handlers/tools/delegate.ts
import type { ServerResponse } from 'node:http';
import type { IncomingMessage } from 'node:http';
import * as delegate from '@zhixuan92/multi-model-agent-core/tools/delegate/schema';
import { executeTask } from '@zhixuan92/multi-model-agent-core/lifecycle/task-executor';
import { toolConfig } from '@zhixuan92/multi-model-agent-core/tools/delegate/tool-config';
import { sendError, sendJson } from '../../errors.js';
import { asyncDispatch } from '../../async-dispatch.js';
import type { HandlerDeps } from '../../handler-deps.js';
import { emitRequestReceived } from '../../request-observability.js';
import type { RawHandler } from '../../types.js';

export function buildDelegateHandler(deps: HandlerDeps): RawHandler {
  return async (_req: IncomingMessage, res: ServerResponse, _params: Record<string, string>, ctx) => {
    const parsed = delegate.inputSchema.safeParse(ctx.body);
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

    const blockIds = input.tasks.flatMap(t => t.contextBlockIds ?? []);
    const { batchId, statusUrl } = asyncDispatch({
      tool: 'delegate',
      projectCwd: cwd,
      blockIds,
      batchRegistry: deps.batchRegistry,
      projectContext: pc,
      deps,
      executor: async (executionCtx) => {
        console.error(`[delegate DEBUG] has routeDispatcher: ${!!deps.routeDispatcher}`);
        const callExecutor = () => executeTask(toolConfig, executionCtx, input);
        if (deps.routeDispatcher) {
          let result;
          try {
            result = await deps.routeDispatcher.dispatch({
              route: 'delegate',
              toolCategory: 'artifact_producing',
              rawRequest: input,
              executor: () => callExecutor(),
            });
            console.error(`[delegate DEBUG] dispatch OK, body keys:`, Object.keys(result.body as object || {}));
          } catch (err) {
            console.error(`[delegate DEBUG] dispatch ERROR:`, (err as Error).message);
            throw err;
          }
          return result.body;
        }
        const direct = await callExecutor();
        console.error(`[delegate DEBUG] direct body keys:`, Object.keys(direct as object));
        console.error(`[delegate DEBUG] direct body.batchId:`, (direct as any)?.batchId);
        return direct;
      },
    });

    await emitRequestReceived({ config: deps.config, batchId, route: _req.url ?? '', parsed: input });

    sendJson(res, 202, { batchId, statusUrl });
  };
}
