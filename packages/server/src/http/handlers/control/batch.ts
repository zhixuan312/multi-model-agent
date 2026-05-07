// packages/server/src/http/handlers/control/batch.ts
import type { ServerResponse } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { sendError, sendJson } from '../../errors.js';
import type { RawHandler } from '../../types.js';
import { notApplicable, type BatchRegistry, formatElapsed } from '@zhixuan92/multi-model-agent-core';

export interface BatchHandlerDeps {
  batchRegistry: BatchRegistry;
}

/**
 * GET /batch/:batchId — poll a batch.
 *
 * Status split (Theme 7):
 *  - pending                → 202 text/plain — body is the runningHeadline
 *  - complete/failed/expired → 200 JSON uniform 7-field envelope
 *
 * Optional ?taskIndex=N slices `results` on a complete envelope.
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

    const entry = deps.batchRegistry.get(batchId);
    if (!entry) {
      sendError(res, 404, 'not_found', `Batch ${batchId} not found`);
      return;
    }

    // Parse optional taskIndex BEFORE checking batch state — syntactic
    // validation is independent of state, and clients shouldn't get a 202
    // when the request URL itself is malformed.
    const rawTaskIndex = ctx.url.searchParams.get('taskIndex');
    let taskIndex: number | null = null;
    if (rawTaskIndex !== null) {
      if (!/^\d+$/.test(rawTaskIndex)) {
        sendError(
          res,
          400,
          'invalid_task_index',
          `taskIndex must be a non-negative integer; got: ${JSON.stringify(rawTaskIndex)}`,
        );
        return;
      }
      taskIndex = parseInt(rawTaskIndex, 10);
    }

    // Pending → 202 text/plain progress line
    if (entry.state === 'pending') {
      const snap = entry.runningHeadlineSnapshot;
      const elapsedMs = Date.now() - snap.dispatchedAt;
      const headline = snap.prefix
        ? `${snap.prefix}${formatElapsed(elapsedMs)}${snap.statsClause}`
        : snap.fallback;
      res.writeHead(202, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(headline);
      return;
    }

    const fullResult = entry.result as Record<string, unknown> | undefined;

    if (entry.state === 'failed' || entry.state === 'expired' || !fullResult) {
      const reason = `batch ${entry.state}`;
      const errPayload = entry.error ?? (fullResult && fullResult['error']) ?? notApplicable('batch succeeded');
      sendJson(res, 200, {
        headline:
          entry.state === 'expired'
            ? 'batch expired'
            : entry.state === 'failed'
              ? 'batch failed'
              : (fullResult?.['headline'] as string | undefined) ?? `batch ${entry.state}`,
        results: (fullResult?.['results'] as unknown) ?? notApplicable(reason),
        batchTimings: (fullResult?.['batchTimings'] as unknown) ?? notApplicable(reason),
        costSummary: (fullResult?.['costSummary'] as unknown) ?? notApplicable(reason),
        structuredReport: (fullResult?.['structuredReport'] as unknown) ?? notApplicable(reason),
        error: errPayload,
      });
      return;
    }

    // entry.state === 'complete' with a stored result. Executor emits all 7 fields.
    if (taskIndex !== null) {
      const results = fullResult['results'];
      if (!Array.isArray(results) || taskIndex >= results.length) {
        sendError(
          res,
          404,
          'unknown_task_index',
          `taskIndex ${taskIndex} is out of range (batch has ${Array.isArray(results) ? results.length : 0} result(s))`,
        );
        return;
      }
      sendJson(res, 200, { ...fullResult, results: [results[taskIndex]] });
      return;
    }

    sendJson(res, 200, fullResult);
  };
}
