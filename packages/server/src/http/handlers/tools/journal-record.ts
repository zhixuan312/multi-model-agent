import * as journal from '@zhixuan92/multi-model-agent-core/tools/journal/record/schema';
import { executeTask } from '@zhixuan92/multi-model-agent-core/lifecycle/task-executor';
import { toolConfig } from '@zhixuan92/multi-model-agent-core/tools/journal/record/tool-config';
import type { ExecutionContext } from '@zhixuan92/multi-model-agent-core';
import { sendError, sendJson } from '../../errors.js';
import { asyncDispatch } from '../../async-dispatch.js';
import { withProjectJournalLock } from '../../journal-lock.js';
import type { HandlerDeps } from '../../handler-deps.js';
import { emitRequestReceived } from '../../request-observability.js';
import type { RawHandler } from '../../types.js';

/** Lock-wrapped executor for one journal-record dispatch. Exported for wiring tests.
 *  The lock + executor are injectable (defaulting to the real ones) so the wiring
 *  test can supply fakes WITHOUT mock.module() — which under Bun is process-global
 *  and sticky, leaking a mocked task-executor into every later dispatch test. */
export interface JournalRecordExecutorDeps {
  executeTask: typeof executeTask;
  withProjectJournalLock: typeof withProjectJournalLock;
}
export function journalRecordExecutor(
  input: journal.Input,
  cwd: string,
  deps: JournalRecordExecutorDeps = { executeTask, withProjectJournalLock },
) {
  return (executionCtx: ExecutionContext) =>
    deps.withProjectJournalLock(cwd, () => deps.executeTask(toolConfig, executionCtx, input));
}

export function buildJournalRecordHandler(deps: HandlerDeps): RawHandler {
  return async (_params, ctx) => {
    const parsed = journal.inputSchema.safeParse(ctx.body);
    if (!parsed.success) {
      return sendError(400, 'invalid_request', 'Request body validation failed', { fieldErrors: parsed.error.flatten() });
    }
    const input = parsed.data;
    const cwd = ctx.cwd!;
    const reserveResult = deps.projectRegistry.reserveProject(cwd);
    if (!reserveResult.ok) { return sendError(503, reserveResult.error, reserveResult.message); }
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
    await emitRequestReceived(deps, batchId, ctx.url.pathname + ctx.url.search, input);
    return sendJson(202, { batchId, statusUrl });
  };
}
