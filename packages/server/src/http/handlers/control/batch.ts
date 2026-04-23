// packages/server/src/http/handlers/control/batch.ts
import type { ServerResponse } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { sendError, sendJson } from '../../errors.js';
import type { RawHandler } from '../../router.js';
import type { BatchRegistry } from '@zhixuan92/multi-model-agent-core';

export interface BatchHandlerDeps {
  batchRegistry: BatchRegistry;
}

/**
 * GET /batch/:batchId — poll the current state of a batch.
 * Optional ?taskIndex=N query param slices a single task result from a
 * complete batch.
 *
 * State mapping:
 *  pending              → 200 { state, startedAt }
 *  awaiting_clarification → 200 { state, proposedInterpretation }
 *  complete             → 200 { state, result } (or sliced if taskIndex given)
 *  failed               → 200 { state, error }
 *  expired              → 200 { state: 'expired' }
 *
 * Errors:
 *  unknown batchId         → 404 not_found
 *  non-numeric taskIndex   → 400 invalid_task_index
 *  taskIndex ≥ results.len → 404 unknown_task_index
 */
export function buildBatchHandler(deps: BatchHandlerDeps): RawHandler {
  return async (
    _req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
    ctx,
  ) => {
    const { batchId } = params;

    // ── 1. Lookup ──────────────────────────────────────────────────────────
    const entry = deps.batchRegistry.get(batchId);
    if (!entry) {
      sendError(res, 404, 'not_found', `Batch ${batchId} not found`);
      return;
    }

    // ── 2. Parse optional taskIndex ────────────────────────────────────────
    const rawTaskIndex = ctx.url.searchParams.get('taskIndex');
    let taskIndex: number | null = null;
    if (rawTaskIndex !== null) {
      if (!/^\d+$/.test(rawTaskIndex)) {
        sendError(res, 400, 'invalid_task_index', `taskIndex must be a non-negative integer; got: ${JSON.stringify(rawTaskIndex)}`);
        return;
      }
      taskIndex = parseInt(rawTaskIndex, 10);
    }

    // ── 3. State mapping ───────────────────────────────────────────────────
    switch (entry.state) {
      case 'pending':
        sendJson(res, 200, { state: 'pending', startedAt: entry.startedAt });
        return;

      case 'awaiting_clarification':
        sendJson(res, 200, {
          state: 'awaiting_clarification',
          proposedInterpretation: entry.proposedInterpretation,
        });
        return;

      case 'complete': {
        const fullResult = entry.result as { results?: unknown[] } | undefined;

        if (taskIndex !== null) {
          const results = fullResult?.results;
          if (!Array.isArray(results) || taskIndex >= results.length) {
            sendError(
              res,
              404,
              'unknown_task_index',
              `taskIndex ${taskIndex} is out of range (batch has ${Array.isArray(results) ? results.length : 0} result(s))`,
            );
            return;
          }
          // Return the full result shape with only the sliced task
          sendJson(res, 200, {
            state: 'complete',
            result: { ...fullResult, results: [results[taskIndex]] },
          });
          return;
        }

        sendJson(res, 200, { state: 'complete', result: fullResult });
        return;
      }

      case 'failed':
        sendJson(res, 200, { state: 'failed', error: entry.error });
        return;

      case 'expired':
        sendJson(res, 200, { state: 'expired' });
        return;

      default: {
        // Exhaustiveness guard — should never happen
        const _never: never = entry.state;
        sendError(res, 500, 'internal_error', `Unexpected batch state: ${String(_never)}`);
      }
    }
  };
}
