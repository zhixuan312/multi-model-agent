// packages/server/src/http/handlers/tools/review.ts
import type { ServerResponse } from 'node:http';
import type { IncomingMessage } from 'node:http';
import * as review from '@zhixuan92/multi-model-agent-core/tool-schemas/review';
import { executeReview } from '@zhixuan92/multi-model-agent-core/executors/review';
import { sendError, sendJson } from '../../errors.js';
import { asyncDispatch } from '../../async-dispatch.js';
import type { HandlerDeps } from '../../handler-deps.js';
import { emitRequestReceived } from '../../request-observability.js';
import type { RawHandler } from '../../router.js';
import { assertCrossTierConfigured } from '../../cross-tier-guard.js';
import { resolveReadOnlyReviewFlag } from '@zhixuan92/multi-model-agent-core/config/read-only-review-flag';

export function buildReviewHandler(deps: HandlerDeps): RawHandler {
  return async (_req: IncomingMessage, res: ServerResponse, _params: Record<string, string>, ctx) => {
    const parsed = review.inputSchema.safeParse(ctx.body);
    if (!parsed.success) {
      sendError(res, 400, 'invalid_request', 'Request body validation failed', {
        fieldErrors: parsed.error.flatten(),
      });
      return;
    }

    const flag = resolveReadOnlyReviewFlag();
    if (flag.isEnabledFor('review_code') && !assertCrossTierConfigured(deps.config, res)) return;

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
      tool: 'review',
      projectCwd: cwd,
      blockIds,
      batchRegistry: deps.batchRegistry,
      projectContext: pc,
      deps,
      executor: async (executionCtx) => {
        return executeReview(executionCtx, input);
      },
    });

    await emitRequestReceived({ config: deps.config, batchId, route: _req.url ?? '', parsed: input });

    sendJson(res, 202, { batchId, statusUrl });
  };
}
