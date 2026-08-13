// Unified execution handlers — thin REST adapters over the application layer.
// POST /execution: validate the wire body (Zod) + build a CallerContext from the
// request, then hand off to ExecutionRuntime.submit(). GET /execution/:executionId:
// shape the registry entry for polling. No type-specific logic lives here —
// preprocessing, pipeline invocation and envelope construction are all owned
// by packages/server/src/application/.

import type { RawHandler } from '../types.js';
import type { HandlerDeps } from '../handler-deps.js';
import { taskInputSchema, type ApprovedContract } from '@zhixuan92/multi-model-agent-core';
import { sendJson, sendError } from '../errors.js';
import type { SubmitError } from '../../application/execution-runtime.js';
import { executionIdentity, buildRunningSnapshot } from '../../application/task-identity.js';
import { validateDeliverableContractBoundary } from '../../application/deliverable-contract-validator.js';

/** Map an application-layer submit error onto the REST status/code contract. */
function submitErrorToHttp(error: SubmitError): { status: number; code: string; message: string } {
  switch (error.kind) {
    case 'agent_not_configured':
      return { status: 503, code: 'agent_not_configured', message: error.message };
    case 'skill_load_failed':
      return { status: 500, code: 'skill_load_failed', message: error.message };
    case 'project_reservation':
      return { status: 503, code: error.code, message: error.message };
    case 'execution_admission':
      return { status: 503, code: error.code, message: error.message };
    // SPEC-003 Task I-6: unknown Initiative / malformed membership / absent authorization all
    // surface as invalid_request; a Task outside open|claimed as invalid_task_transition; a
    // claimed Task with a mismatched authorized_by as task_claim_conflict — all HTTP 400.
    case 'linked_admission':
      return { status: 400, code: error.code, message: error.message };
    // SPEC-005 Task I-4: an explicit request Method that does not name a registered Method.
    case 'unknown_method':
      return { status: 400, code: 'unknown_method', message: error.message };
  }
}

export function buildUnifiedExecutionHandler(deps: HandlerDeps): RawHandler {
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

    // Deliverable Contract boundary: realpath containment of every declared artifact
    // root and command cwd, plus disposition/git feasibility — the filesystem-dependent
    // checks core cannot do. Runs before ExecutionRuntime.submit so a rejected contract
    // never opens a provider session. `deliverable` is present only on spec/plan/
    // execute_plan/review input variants; absent elsewhere.
    const deliverable = (parsed.data as Record<string, unknown>).deliverable as ApprovedContract | undefined;
    const boundary = validateDeliverableContractBoundary(deliverable, cwd);
    if (!boundary.ok) {
      sendError(res, 400, 'invalid_request', 'Validation failed', { fieldErrors: boundary.fieldErrors });
      return;
    }

    const outcome = await deps.runtime.submit(parsed.data, {
      clientName: ctx.callerClient,
      projectRoot: cwd,
    });

    if (!outcome.ok) {
      const { status, code, message } = submitErrorToHttp(outcome.error);
      sendError(res, status, code, message);
      return;
    }

    const admitted = deps.executionRegistry.get(outcome.executionId);
    sendJson(res, 202, {
      ...(admitted ? executionIdentity(admitted) : { executionId: outcome.executionId, type: parsed.data.type }),
      statusUrl: `/execution/${outcome.executionId}`,
    });
  };
}

export function buildExecutionPollHandler(deps: HandlerDeps): RawHandler {
  return async (_req, res, params, _ctx) => {
    const executionId = params.executionId;
    if (!executionId) {
      sendError(res, 400, 'missing_execution_id', 'executionId required');
      return;
    }

    const entry = deps.executionRegistry.get(executionId);
    if (!entry) {
      // Durable fallback: terminal results survive a daemon restart (and
      // registry TTL eviction) in the ExecutionStore — including executions
      // reconciled to `interrupted` at boot, whose envelope tells the caller
      // to resubmit. Non-terminal store rows belong to another live daemon
      // and are not pollable here.
      const record = deps.store.get(executionId);
      if (record?.resultJson != null) {
        sendJson(res, 200, JSON.parse(record.resultJson));
        return;
      }
      sendError(res, 404, 'not_found', `Execution ${executionId} not found`);
      return;
    }

    if (deps.executionRegistry.isTerminal(executionId)) {
      sendJson(res, 200, entry.result ?? { ...executionIdentity(entry), status: entry.state, error: null });
    } else {
      // Built by the SAME function the MCP adapter calls, not a second copy of the shape.
      // The two hand-maintained copies this replaces had already drifted once.
      sendJson(res, 202, buildRunningSnapshot(entry));
    }
  };
}

/**
 * DELETE /execution/:executionId — request cooperative cancellation. 202 means
 * REQUESTED, not stopped: the execution stays `running` (with
 * cancellationRequested: true on polls) until the runner confirms
 * termination, then reaches terminal `cancelled` — unless completion won the
 * race, in which case the completed/failed result stands. Idempotent.
 */
export function buildExecutionCancelHandler(deps: HandlerDeps): RawHandler {
  return async (_req, res, params, _ctx) => {
    const executionId = params.executionId;
    if (!executionId) {
      sendError(res, 400, 'missing_execution_id', 'executionId required');
      return;
    }

    const result = deps.runtime.cancel(executionId);
    if (result.outcome === 'not_found') {
      sendError(res, 404, 'not_found', `Execution ${executionId} not found`);
      return;
    }
    if (result.outcome === 'terminal') {
      sendJson(res, 200, { ...executionIdentity(result.entry), status: result.entry.state, alreadyTerminal: true });
      return;
    }
    sendJson(res, 202, { ...executionIdentity(result.entry), status: 'running', cancellationRequested: true });
  };
}
