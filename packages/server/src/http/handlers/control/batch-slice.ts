// packages/server/src/http/handlers/control/batch-slice.ts
import { z } from 'zod';
import { sendError, sendJson } from '../../errors.js';
import type { HandlerDeps } from '../../handler-deps.js';
import type { RawHandler } from '../../types.js';

const inputSchema = z.object({
  batchId: z.string(),
  taskIndex: z.number().int().nonnegative(),
});

export function buildBatchSliceHandler(deps: HandlerDeps): RawHandler {
  return async (_params, ctx) => {
    const parsed = inputSchema.safeParse(ctx.body);
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

    // T4: use the registry/delegate batchId directly as the cache key.
    const entry = pc.batchCache.get(input.batchId);
    if (!entry) {
      return sendError(404, 'not_found', `Batch ${input.batchId} not found`);
    }

    const results = entry.results;
    if (!Array.isArray(results) || input.taskIndex >= results.length) {
      return sendError(
        404,
        'unknown_task_index',
        `taskIndex ${input.taskIndex} is out of range (batch has ${Array.isArray(results) ? results.length : 0} result(s))`,
      );
    }

    return sendJson(200, { batchId: input.batchId, result: results[input.taskIndex] });
  };
}
