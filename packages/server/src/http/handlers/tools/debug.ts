// packages/server/src/http/handlers/tools/debug.ts
import type { ServerResponse } from 'node:http';
import type { IncomingMessage } from 'node:http';
import * as debug from '@zhixuan92/multi-model-agent-core/tool-schemas/debug';
import { executeDebug } from '@zhixuan92/multi-model-agent-core/executors/debug';
import { sendError, sendJson } from '../../errors.js';
import { asyncDispatch } from '../../async-dispatch.js';
import type { HandlerDeps } from '../../handler-deps.js';
import { emitRequestReceived } from '../../request-observability.js';
import type { RawHandler } from '../../router.js';
import { assertCrossTierConfigured } from '../../cross-tier-guard.js';
import { resolveReadOnlyReviewFlag } from '@zhixuan92/multi-model-agent-core/config/read-only-review-flag';

export function buildDebugHandler(deps: HandlerDeps): RawHandler {
  return async (_req: IncomingMessage, res: ServerResponse, _params: Record<string, string>, ctx) => {
    const parsed = debug.inputSchema.safeParse(ctx.body);
    if (!parsed.success) {
      sendError(res, 400, 'invalid_request', 'Request body validation failed', {
        fieldErrors: parsed.error.flatten(),
      });
      return;
    }

    const flag = resolveReadOnlyReviewFlag();
    if (flag.isEnabledFor('debug_task') && !assertCrossTierConfigured(deps.config, res)) return;

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
