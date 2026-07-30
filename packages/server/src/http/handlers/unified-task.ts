// Unified task handlers — thin REST adapters over the application layer.
// POST /task: validate the wire body (Zod) + build a CallerContext from the
// request, then hand off to ExecutionRuntime.submit(). GET /task/:taskId:
// shape the registry entry for polling. No type-specific logic lives here —
// preprocessing, pipeline invocation and envelope construction are all owned
// by packages/server/src/application/.

import type { RawHandler } from '../types.js';
import type { HandlerDeps } from '../handler-deps.js';
import { taskInputSchema } from '@zhixuan92/multi-model-agent-core';
import { sendJson, sendError } from '../errors.js';
import type { SubmitError } from '../../application/execution-runtime.js';

/** Map an application-layer submit error onto the REST status/code contract. */
function submitErrorToHttp(error: SubmitError): { status: number; code: string; message: string } {
  switch (error.kind) {
    case 'agent_not_configured':
      return { status: 503, code: 'agent_not_configured', message: error.message };
    case 'skill_load_failed':
      return { status: 500, code: 'skill_load_failed', message: error.message };
    case 'project_reservation':
      return { status: 503, code: error.code, message: error.message };
  }
}

export function buildUnifiedTaskHandler(deps: HandlerDeps): RawHandler {
  return async (_req, res, _params, ctx) => {
    const parsed = taskInputSchema.safeParse(ctx.body);
    if (!parsed.success) {
      sendError(res, 400, 'invalid_request', 'Validation failed', {
        fieldErrors: parsed.error.flatten(),
      });
      return;
    }

    const cwd = ctx.cwd;
    if (!cwd) {
      sendError(res, 400, 'invalid_cwd', 'cwd query parameter required');
      return;
    }

    const outcome = await deps.runtime.submit(parsed.data, {
      clientName: ctx.callerClient,
      mainModel: ctx.mainModel,
      projectRoot: cwd,
    });

    if (!outcome.ok) {
      const { status, code, message } = submitErrorToHttp(outcome.error);
      sendError(res, status, code, message);
      return;
    }

    sendJson(res, 202, { taskId: outcome.taskId, statusUrl: `/task/${outcome.taskId}` });
  };
}

export function buildTaskPollHandler(deps: HandlerDeps): RawHandler {
  return async (_req, res, params, _ctx) => {
    const taskId = params.taskId;
    if (!taskId) {
      sendError(res, 400, 'missing_task_id', 'taskId required');
      return;
    }

    const entry = deps.taskRegistry.get(taskId);
    if (!entry) {
      // Durable fallback: terminal results survive a daemon restart (and
      // registry TTL eviction) in the ExecutionStore — including executions
      // reconciled to `interrupted` at boot, whose envelope tells the caller
      // to resubmit. Non-terminal store rows belong to another live daemon
      // and are not pollable here.
      const record = deps.store.get(taskId);
      if (record?.resultJson != null) {
        sendJson(res, 200, JSON.parse(record.resultJson));
        return;
      }
      sendError(res, 404, 'not_found', `Task ${taskId} not found`);
      return;
    }

    if (deps.taskRegistry.isTerminal(taskId)) {
      sendJson(res, 200, entry.result ?? { taskId, status: entry.state, error: null });
    } else {
      const now = Date.now();
      const polling: Record<string, unknown> = {
        taskId,
        status: 'running',
        phase: entry.phase ?? 'implementing',
        elapsedMs: now - entry.startedAt,
        phaseElapsedMs: entry.phaseStartedAt ? now - entry.phaseStartedAt : now - entry.startedAt,
        startedAt: new Date(entry.startedAt).toISOString(),
      };
      if (entry.cancellationRequestedAt !== null) {
        polling.cancellationRequested = true;
      }
      if (entry.tool === 'execute_plan' && entry.totalTasks != null) {
        polling.totalTasks = entry.totalTasks;
      }
      // The human-readable headline was written by TaskRegistry.setHeadline but read by
      // nothing — dead state. Present only when non-null, identically to the MCP
      // running snapshot (one contract, two wires).
      if (entry.runningHeadline !== null) {
        polling.runningHeadline = entry.runningHeadline;
      }
      sendJson(res, 202, polling);
    }
  };
}

/**
 * DELETE /task/:taskId — request cooperative cancellation. 202 means
 * REQUESTED, not stopped: the task stays `running` (with
 * cancellationRequested: true on polls) until the runner confirms
 * termination, then reaches terminal `cancelled` — unless completion won the
 * race, in which case the completed/failed result stands. Idempotent.
 */
export function buildTaskCancelHandler(deps: HandlerDeps): RawHandler {
  return async (_req, res, params, _ctx) => {
    const taskId = params.taskId;
    if (!taskId) {
      sendError(res, 400, 'missing_task_id', 'taskId required');
      return;
    }

    const result = deps.runtime.cancel(taskId);
    if (result.outcome === 'not_found') {
      sendError(res, 404, 'not_found', `Task ${taskId} not found`);
      return;
    }
    if (result.outcome === 'terminal') {
      sendJson(res, 200, { taskId, status: result.entry.state, alreadyTerminal: true });
      return;
    }
    sendJson(res, 202, { taskId, status: 'running', cancellationRequested: true });
  };
}
