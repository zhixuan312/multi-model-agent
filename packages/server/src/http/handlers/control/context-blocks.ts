// POST /context-blocks (register) and DELETE /context-blocks/:id (unregister).
// Synchronous state ops — no async dispatch, no pipeline.
//
// The REAL logic is `createContextBlock` / `deleteContextBlock` in
// `application/context-block-ops.ts`: plain arguments in, a discriminated result out. The handlers
// here unwrap `ctx` into those arguments and format the result as an HTTP response — nothing else.
// The MCP adapter calls the same two operations, from the same place, so neither transport is a
// second implementation and neither imports the other.
//
// The status mapping lives HERE because it is a REST concern: the operations return a `code`, and
// `contextBlockErrorToHttp` turns it into a status, exactly as `initiativeErrorToHttp` does for the
// shared Initiative classification.
//
// `ctx.cwd` is already canonical by the time it reaches either handler (cwd-required middleware,
// request-pipeline.ts).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendError, sendJson } from '../../errors.js';
import type { RawHandler } from '../../types.js';
import {
  createContextBlock,
  deleteContextBlock,
  type ContextBlockOpDeps,
  type ContextBlockOpErrorCode,
  type DeleteContextBlockOpDeps,
} from '../../../application/context-block-ops.js';

/**
 * Operation error code → HTTP status.
 *
 * Exhaustive by construction: the `never` assignment fails to compile if a new
 * `ContextBlockOpErrorCode` is added without a status decided for it, so a new failure mode cannot
 * silently inherit someone's default.
 */
export function contextBlockErrorToHttp(code: ContextBlockOpErrorCode): number {
  switch (code) {
    case 'invalid_request': return 400;
    case 'payload_too_large': return 413;
    case 'not_found': return 404;
    case 'cap_exhausted': return 409;
    case 'pinned': return 409;
    // Every ReserveError: the registry could not admit the project. 503 — the caller should retry
    // once active work drains, rather than change the request.
    case 'project_cap':
    case 'invalid_cwd':
    case 'missing_cwd':
    case 'cwd_not_dir':
    case 'forbidden_cwd':
      return 503;
    default: {
      const exhaustive: never = code;
      return exhaustive;
    }
  }
}

/** POST /context-blocks — thin REST wrapper over `createContextBlock`. */
export function buildCreateContextBlockHandler(deps: ContextBlockOpDeps): RawHandler {
  return async (
    _req: IncomingMessage,
    res: ServerResponse,
    _params: Record<string, string>,
    ctx,
  ) => {
    const body = (ctx.body ?? {}) as { content?: unknown; ttlMs?: unknown };
    const result = createContextBlock(deps, { cwd: ctx.cwd!, content: body.content, ttlMs: body.ttlMs });
    if (!result.ok) {
      sendError(res, contextBlockErrorToHttp(result.code), result.code, result.message, result.extra);
      return;
    }
    sendJson(res, 201, { id: result.id });
  };
}

/** DELETE /context-blocks/:blockId — thin REST wrapper over `deleteContextBlock`. */
export function buildDeleteContextBlockHandler(deps: DeleteContextBlockOpDeps): RawHandler {
  return async (
    _req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
    ctx,
  ) => {
    const result = deleteContextBlock(deps, { cwd: ctx.cwd!, blockId: params.blockId! });
    if (!result.ok) {
      sendError(res, contextBlockErrorToHttp(result.code), result.code, result.message, result.extra);
      return;
    }
    sendJson(res, 200, { ok: true });
  };
}
