// packages/server/src/http/handlers/control/clarifications.ts
import type { ServerResponse } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { z } from 'zod';
import { InvalidBatchStateError } from '@zhixuan92/multi-model-agent-core';
import { sendError, sendJson } from '../../errors.js';
import type { RawHandler } from '../../router.js';
import type { BatchRegistry } from '@zhixuan92/multi-model-agent-core';

export interface ClarificationsHandlerDeps {
  batchRegistry: BatchRegistry;
}

const confirmBodySchema = z.object({
  batchId: z.string().uuid(),
  interpretation: z.string().min(1),
});

/**
 * POST /clarifications/confirm — confirms (or idempotently re-confirms) an
 * awaiting_clarification batch by providing the caller's chosen interpretation.
 *
 * Auth required; NOT cwd-gated (operates on a batchId, not a project cwd).
 *
 * Success → 200 { batchId, state: <current state after confirmation> }
 * Errors:
 *   invalid body   → 400 invalid_request
 *   unknown batchId → 404 not_found
 *   wrong state w/ different interpretation → 409 invalid_batch_state
 */
export function buildClarificationsHandler(deps: ClarificationsHandlerDeps): RawHandler {
  return async (
    _req: IncomingMessage,
    res: ServerResponse,
    _params: Record<string, string>,
    ctx,
  ) => {
    // ── 1. Validate body ───────────────────────────────────────────────────
    const parsed = confirmBodySchema.safeParse(ctx.body);
    if (!parsed.success) {
      sendError(res, 400, 'invalid_request', 'Request body validation failed', {
        fieldErrors: parsed.error.flatten(),
      });
      return;
    }

    const { batchId, interpretation } = parsed.data;

    // ── 2. Lookup ──────────────────────────────────────────────────────────
    const entry = deps.batchRegistry.get(batchId);
    if (!entry) {
      sendError(res, 404, 'not_found', `Batch ${batchId} not found`);
      return;
    }

    // ── 3. Resume (handles idempotency + state validation) ─────────────────
    try {
      deps.batchRegistry.resumeFromClarification(batchId, interpretation);
    } catch (err) {
      if (err instanceof InvalidBatchStateError) {
        sendError(res, 409, 'invalid_batch_state', `Cannot confirm clarification: batch is in state '${err.currentState}'`, {
          currentState: err.currentState,
        });
        return;
      }
      throw err;
    }

    // ── 4. Echo current state ──────────────────────────────────────────────
    // Re-read the entry after resumeFromClarification — the batch may have
    // already completed if the executor was waiting.
    const updatedEntry = deps.batchRegistry.get(batchId);
    const currentState = updatedEntry?.state ?? 'pending';

    sendJson(res, 200, { batchId, state: currentState });
  };
}
