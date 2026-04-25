// packages/server/src/http/handlers/tools/execute-plan.ts
import type { ServerResponse } from 'node:http';
import type { IncomingMessage } from 'node:http';
import * as executePlan from '@zhixuan92/multi-model-agent-core/tool-schemas/execute-plan';
import { executeExecutePlan } from '@zhixuan92/multi-model-agent-core/executors/execute-plan';
import { sendError, sendJson } from '../../errors.js';
import { asyncDispatch } from '../../async-dispatch.js';
import type { HandlerDeps } from '../../handler-deps.js';
import { emitRequestReceived } from '../../request-observability.js';
import type { RawHandler } from '../../router.js';

export function buildExecutePlanHandler(deps: HandlerDeps): RawHandler {
  return async (_req: IncomingMessage, res: ServerResponse, _params: Record<string, string>, ctx) => {
    const parsed = executePlan.inputSchema.safeParse(ctx.body);
    if (!parsed.success) {
      const fieldErrors: Record<string, string[]> = {};
      for (const issue of parsed.error.issues) {
        let path = issue.path.join('.');
        if (path === '' && issue.message.includes('"agentType"')) {
          path = 'agentType';
        } else if (path.startsWith('tasks.') && issue.message === 'Invalid input') {
          const task = issue.path.reduce<unknown>((value, segment) => {
            if (value && typeof value === 'object') return (value as Record<string | number, unknown>)[segment as string | number];
            return undefined;
          }, ctx.body);
          if (task && typeof task === 'object' && 'agentType' in task) {
            path = `${path}.agentType`;
          }
        }
        if (!fieldErrors[path]) fieldErrors[path] = [];
        fieldErrors[path].push(issue.message);
      }
      sendError(res, 400, 'invalid_request', 'Request body validation failed', { fieldErrors });
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

    const blockIds = input.contextBlockIds ?? [];
    const { batchId, statusUrl } = asyncDispatch({
      tool: 'execute-plan',
      projectCwd: cwd,
      blockIds,
      batchRegistry: deps.batchRegistry,
      projectContext: pc,
      deps,
      executor: async (executionCtx) => {
        return executeExecutePlan(executionCtx, input);
      },
    });

    await emitRequestReceived({ config: deps.config, batchId, route: _req.url ?? '', parsed: input });

    sendJson(res, 202, { batchId, statusUrl });
  };
}
