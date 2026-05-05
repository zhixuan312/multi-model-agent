// packages/server/src/http/handlers/tools/execute-plan.ts
import type { ServerResponse } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { executePlanInputSchema } from '@zhixuan92/multi-model-agent-core/tools/execute-plan/tool-config';
import type { ExecutePlanWireInput } from '@zhixuan92/multi-model-agent-core/tools/execute-plan/tool-config';
import { executeExecutePlan } from '@zhixuan92/multi-model-agent-core/lifecycle/executors/execute-plan';
import { sendError, sendJson } from '../../errors.js';
import { asyncDispatch } from '../../async-dispatch.js';
import type { HandlerDeps } from '../../handler-deps.js';
import { emitRequestReceived } from '../../request-observability.js';
import type { RawHandler } from '../../types.js';

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
        const callExecutor = () => executeExecutePlan(executionCtx, {
          tasks: input.taskDescriptors,
          filePaths: input.filePaths,
        });
        if (deps.routeDispatcher) {
          const result = await deps.routeDispatcher.dispatch({
            route: 'execute_plan',
            toolCategory: 'artifact_producing',
            rawRequest: input,
            executor: () => callExecutor(),
          });
          return result.body;
        }
        return callExecutor();
      },
    });

    await emitRequestReceived({ config: deps.config, batchId, route: _req.url ?? '', parsed: input });

    sendJson(res, 202, { batchId, statusUrl });
  };
}
