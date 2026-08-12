// POST /initiatives — the single HTTP adapter for the complete frozen
// Initiative operation table (SPEC-001, "Interfaces / contracts"). Thin: all
// validation, dispatch, and read-model assembly live in the shared
// `InitiativeRecordRuntime` (packages/server/src/application/), which is the
// SAME runtime the MCP adapter (Task I-7) will call. This handler's only
// jobs are (1) route `initiative_resume` to its dedicated assembly method and
// every other operation to `execute()`, (2) overwrite adapter-owned
// provenance (`interface`, `timestamp`) on mutation requests before the
// runtime ever sees caller-supplied values for them, and (3) map the
// runtime's typed errors onto the pinned HTTP status codes.

import type { RawHandler } from '../types.js';
import type { HandlerDeps } from '../handler-deps.js';
import { sendJson, sendError } from '../errors.js';
import {
  RevisionConflictError,
  CrossProductWorkspaceLinkError,
  InitiativeNotFoundError,
  InitiativeInvalidRequestError,
  MigrationBackupFailedError,
} from '@zhixuan92/multi-model-agent-core';

/**
 * Overwrites adapter-owned provenance fields on a mutation request body
 * before it reaches the shared runtime — a caller may send any value for
 * `interface`/`timestamp` (or omit `provenance` entirely on a read-only
 * operation); the HTTP adapter's own value always wins for a mutation, and a
 * body with no `provenance` object is passed through unchanged so the
 * runtime's own Zod validation reports the resulting `invalid_request`.
 */
function stampHttpProvenance(body: unknown): unknown {
  if (typeof body !== 'object' || body === null) return body;
  const record = body as Record<string, unknown>;
  const provenance = record.provenance;
  if (typeof provenance !== 'object' || provenance === null) return body;
  return {
    ...record,
    provenance: {
      ...(provenance as Record<string, unknown>),
      interface: 'http',
      timestamp: new Date().toISOString(),
    },
  };
}

/** Maps a runtime-thrown typed Initiative error onto the pinned HTTP status +
 *  envelope, preserving each error's own detail fields. Anything else
 *  (an unclassified storage failure) falls through to 500. */
function initiativeErrorToHttp(err: unknown): { status: number; code: string; message: string; details?: unknown } {
  if (err instanceof RevisionConflictError) {
    return {
      status: 409,
      code: err.code,
      message: err.message,
      details: {
        entity_type: err.entity_type,
        entity_id: err.entity_id,
        expected_revision: err.expected_revision,
        actual_revision: err.actual_revision,
      },
    };
  }
  if (err instanceof CrossProductWorkspaceLinkError) {
    return {
      status: 409,
      code: err.code,
      message: err.message,
      details: { initiative_id: err.initiative_id, workspace_id: err.workspace_id },
    };
  }
  if (err instanceof InitiativeNotFoundError) {
    return {
      status: 404,
      code: err.code,
      message: err.message,
      details: { entity_type: err.entity_type, lookup: err.lookup },
    };
  }
  if (err instanceof InitiativeInvalidRequestError) {
    return { status: 400, code: err.code, message: err.message, details: { field_errors: err.field_errors } };
  }
  if (err instanceof MigrationBackupFailedError) {
    return {
      status: 500,
      code: err.code,
      message: err.message,
      details: { database_path: err.database_path, backup_path: err.backup_path },
    };
  }
  return { status: 500, code: 'internal_error', message: err instanceof Error ? err.message : 'Unexpected error' };
}

export function buildInitiativeHandler(deps: HandlerDeps): RawHandler {
  return async (_req, res, _params, ctx) => {
    const body = ctx.body;
    const operation =
      typeof body === 'object' && body !== null ? (body as Record<string, unknown>).operation : undefined;

    try {
      if (operation === 'initiative_resume') {
        // `initiative_resume` is not a member of `execute()`'s operation set —
        // it has its own dedicated runtime method and request shape (no
        // `operation`/`input` envelope, just `{ initiative, event_limit? }`).
        // Strip the routing-only `operation` field before handing the rest to
        // the runtime, which validates strictly against that shape.
        const { operation: _op, ...resumeRequest } = body as Record<string, unknown>;
        const result = deps.initiativeRuntime.initiativeResume(resumeRequest);
        sendJson(res, 200, result);
        return;
      }

      const stamped = stampHttpProvenance(body);
      const result = deps.initiativeRuntime.execute(stamped);
      sendJson(res, 200, result);
    } catch (err) {
      const { status, code, message, details } = initiativeErrorToHttp(err);
      sendError(res, status, code, message, details);
    }
  };
}
