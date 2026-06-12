import type { IncomingMessage, ServerResponse } from 'node:http';
import * as journal from '@zhixuan92/multi-model-agent-core/tools/journal/record/schema';
import { executeTask } from '@zhixuan92/multi-model-agent-core/lifecycle/task-executor';
import { toolConfig } from '@zhixuan92/multi-model-agent-core/tools/journal/record/tool-config';
import type { ExecutionContext } from '@zhixuan92/multi-model-agent-core';
import { sendError, sendJson } from '../../errors.js';
import { asyncDispatch } from '../../async-dispatch.js';
import type { HandlerDeps } from '../../handler-deps.js';
import { emitRequestReceived } from '../../request-observability.js';
import type { RawHandler } from '../../types.js';

/**
 * Executor for one journal-record dispatch. Per-cwd serialization is handled by
 * the goal-set's `withWriteGoalLock` (in task-executor), which subsumes the old
 * per-project journal lock — no separate lock here.
 */
export function journalRecordExecutor(input: journal.Input, _cwd: string) {
  return (executionCtx: ExecutionContext) =>
    executeTask(toolConfig, executionCtx, input);
}

export function buildJournalRecordHandler(deps: HandlerDeps): RawHandler {
  return async (_req: IncomingMessage, res: ServerResponse, _params: Record<string, string>, ctx) => {
    const parsed = journal.inputSchema.safeParse(ctx.body);
    if (!parsed.success) {
      sendError(res, 400, 'invalid_request', 'Request body validation failed', { fieldErrors: parsed.error.flatten() });
      return;
    }
    const input = parsed.data;
    const cwd = ctx.cwd!;
    const reserveResult = deps.projectRegistry.reserveProject(cwd);
    if (!reserveResult.ok) { sendError(res, 503, reserveResult.error, reserveResult.message); return; }
    const pc = reserveResult.projectContext;
    pc.lastActivityAt = Date.now();
    deps.projectRegistry.cancelReservation(cwd);

    const blockIds = input.contextBlockIds ?? [];
    const { batchId, statusUrl } = asyncDispatch({
      tool: 'journal-record', projectCwd: cwd, blockIds,
      batchRegistry: deps.batchRegistry, projectContext: pc, deps,
      caller: { client: ctx.callerClient, mainModel: ctx.mainModel },
      executor: journalRecordExecutor(input, cwd),
    });
    await emitRequestReceived(deps, batchId, _req.url ?? '', input);
    sendJson(res, 202, { batchId, statusUrl });
  };
}
