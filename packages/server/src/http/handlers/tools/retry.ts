// packages/server/src/http/handlers/tools/retry.ts
import type { ServerResponse } from 'node:http';
import type { IncomingMessage } from 'node:http';
import * as retry from '@zhixuan92/multi-model-agent-core/tool-schemas/retry';
import { executeRetry } from '@zhixuan92/multi-model-agent-core/lifecycle/executors/retry';
import type { MultiModelConfig, TaskSpec } from '@zhixuan92/multi-model-agent-core';
import { sendError, sendJson } from '../../errors.js';
import { asyncDispatch } from '../../async-dispatch.js';
import type { HandlerDeps } from '../../handler-deps.js';
import type { RawHandler } from '../../router.js';

/** Same inject-defaults logic as delegate — fills harness fields from config. */
function makeInjectDefaults(config: MultiModelConfig, cwd: string): (tasks: TaskSpec[]) => TaskSpec[] {
  return (tasks: TaskSpec[]) =>
    tasks.map(t => ({
      ...t,
      cwd: t.cwd ?? cwd,
      tools: t.tools ?? config.defaults?.tools ?? 'full',
      timeoutMs: t.timeoutMs ?? config.defaults?.timeoutMs ?? 1_800_000,
      maxCostUSD: t.maxCostUSD ?? config.defaults?.maxCostUSD ?? 10,
      sandboxPolicy: t.sandboxPolicy ?? config.defaults?.sandboxPolicy ?? 'cwd-only',
      mainModel: t.mainModel ?? config.defaults?.mainModel ?? process.env['PARENT_MODEL_NAME'],
    }));
}

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

    // v4.0 lifecycle path: when a RouteDispatcher is wired, dispatch through
    // the new lifecycle using the ORIGINAL batch's toolCategory for budget selection.
    if (deps.routeDispatcher) {
      const original = deps.batchRegistry.get(input.batchId);
      if (!original) {
        sendError(res, 404, 'batch_not_found', `batch "${input.batchId}" not found`);
        return;
      }
      if (!original.toolCategory || (original.toolCategory as string) === 'assist') {
        sendError(res, 400, 'invalid_tool_category',
          `retry: original batch '${input.batchId}' has missing or invalid toolCategory ` +
          `'${original.toolCategory}' — refusing to retry with 'assist' (assist is route-level only)`);
        return;
      }
      const result = await deps.routeDispatcher.dispatch({
        route: 'retry',
        toolCategory: original.toolCategory,
        rawRequest: { batchId: input.batchId, retryableFor: input.taskIndices, cwd },
      });
      sendJson(res, result.status, result.body);
      return;
    }

    // Legacy path (async-dispatch via executeRetry) — kept as fallback until
    // server.ts wires routeDispatcher for all tool routes.
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
      executor: async (executionCtx) => {
        return executeRetry(executionCtx, input, {
          injectDefaults: makeInjectDefaults(deps.config, cwd),
        });
      },
    });

    sendJson(res, 202, { batchId, statusUrl });
  };
}
