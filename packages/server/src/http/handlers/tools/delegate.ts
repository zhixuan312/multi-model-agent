// packages/server/src/http/handlers/tools/delegate.ts
import * as delegate from '@zhixuan92/multi-model-agent-core/tools/delegate/schema';
import { executeTask } from '@zhixuan92/multi-model-agent-core/lifecycle/task-executor';
import { toolConfig } from '@zhixuan92/multi-model-agent-core/tools/delegate/tool-config';
import { sendError, sendJson } from '../../errors.js';
import { asyncDispatch } from '../../async-dispatch.js';
import type { HandlerDeps } from '../../handler-deps.js';
import { emitRequestReceived } from '../../request-observability.js';
import type { RawHandler } from '../../types.js';

export function buildDelegateHandler(deps: HandlerDeps): RawHandler {
  return async (_params, ctx) => {
    const parsed = delegate.inputSchema.safeParse(ctx.body);
    if (!parsed.success) {
      return sendError(400, 'invalid_request', 'Request body validation failed', {
        fieldErrors: parsed.error.flatten(),
      });
    }

    const input = parsed.data;
    const cwd = ctx.cwd!;

    const reserveResult = deps.projectRegistry.reserveProject(cwd);
    if (!reserveResult.ok) {
      return sendError(503, reserveResult.error, reserveResult.message);
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
      caller: { client: ctx.callerClient, mainModel: ctx.mainModel },
      executor: async (executionCtx) => {
        return executeTask(toolConfig, executionCtx, input);
      },
    });

    await emitRequestReceived(deps, batchId, ctx.url.pathname + ctx.url.search, input);

    return sendJson(202, { batchId, statusUrl });
  };
}
