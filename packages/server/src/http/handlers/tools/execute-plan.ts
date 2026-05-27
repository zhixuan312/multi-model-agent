// packages/server/src/http/handlers/tools/execute-plan.ts
import { executePlanInputSchema } from '@zhixuan92/multi-model-agent-core/tools/execute-plan/tool-config';
import type { ExecutePlanWireInput } from '@zhixuan92/multi-model-agent-core/tools/execute-plan/tool-config';
import { executeTask } from '@zhixuan92/multi-model-agent-core/lifecycle/task-executor';
import { toolConfig } from '@zhixuan92/multi-model-agent-core/tools/execute-plan/tool-config';
import { sendError, sendJson } from '../../errors.js';
import { asyncDispatch } from '../../async-dispatch.js';
import type { HandlerDeps } from '../../handler-deps.js';
import { emitRequestReceived } from '../../request-observability.js';
import type { RawHandler } from '../../types.js';

export function buildExecutePlanHandler(deps: HandlerDeps): RawHandler {
  return async (_params, ctx) => {
    const parsed = executePlanInputSchema.safeParse(ctx.body);
    if (!parsed.success) {
      return sendError(400, 'invalid_request', 'Request body validation failed', {
        fieldErrors: parsed.error.flatten(),
      });
    }

    // Carry the HTTP `?cwd=` value through to the brief slot via input.cwd.
    // The schema marks cwd as optional; callers normally provide it via URL.
    const cwd = ctx.cwd!;
    const input: ExecutePlanWireInput = { ...parsed.data, cwd } as ExecutePlanWireInput;

    const reserveResult = deps.projectRegistry.reserveProject(cwd);
    if (!reserveResult.ok) {
      return sendError(503, reserveResult.error, reserveResult.message);
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
        return executeTask(toolConfig, executionCtx, input);
      },
    });

    await emitRequestReceived(deps, batchId, ctx.url.pathname + ctx.url.search, input);

    return sendJson(202, { batchId, statusUrl });
  };
}
