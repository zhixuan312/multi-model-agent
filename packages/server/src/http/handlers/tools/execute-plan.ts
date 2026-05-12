// packages/server/src/http/handlers/tools/execute-plan.ts
import type { ServerResponse } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { executePlanInputSchema } from '@zhixuan92/multi-model-agent-core/tools/execute-plan/tool-config';
import type { ExecutePlanWireInput } from '@zhixuan92/multi-model-agent-core/tools/execute-plan/tool-config';
import { executeTask } from '@zhixuan92/multi-model-agent-core/lifecycle/task-executor';
import { toolConfig } from '@zhixuan92/multi-model-agent-core/tools/execute-plan/tool-config';
import { validateVerifyCommand } from '@zhixuan92/multi-model-agent-core/intake/verify-command-validator';
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

    // Carry the HTTP `?cwd=` value through to the brief slot via input.cwd.
    // The schema marks cwd as optional; callers normally provide it via URL.
    const cwd = ctx.cwd!;
    const input: ExecutePlanWireInput = { ...parsed.data, cwd } as ExecutePlanWireInput;

    const vr = validateVerifyCommand(input.verifyCommand);
    if (!vr.ok) {
      sendError(res, 400, 'invalid_request', vr.error!);
      return;
    }

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
      tool: 'execute-plan',
      projectCwd: cwd,
      blockIds,
      batchRegistry: deps.batchRegistry,
      projectContext: pc,
      deps,
      caller: { client: ctx.callerClient, mainModel: ctx.mainModel },
      executor: async (executionCtx) => {
        const callExecutor = () => executeTask(toolConfig, executionCtx, input);
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
