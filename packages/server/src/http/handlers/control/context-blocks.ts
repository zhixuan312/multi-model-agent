// POST /context-blocks (register) and DELETE /context-blocks/:id (unregister).
// Synchronous state ops — no async dispatch, no pipeline.
//
// The REAL logic lives in the two typed operations below (createContextBlock /
// deleteContextBlock): plain arguments in, a discriminated result out — no
// IncomingMessage/ServerResponse anywhere near them. The REST handlers
// (buildCreateContextBlockHandler / buildDeleteContextBlockHandler) are thin
// wrappers that unwrap ctx into plain arguments and format the result as an
// HTTP response. The MCP adapter (mcp-adapter.ts) calls the SAME two
// operations directly — it has no request/response pair to hand a RawHandler,
// so operating on plain arguments is what makes it a caller instead of a
// second implementation. Body validation, byte limits, project caps, pin
// checks, and the mutation itself exist in exactly one place: here.
//
// `cwd` is accepted here ALREADY CANONICAL — resolving a raw cwd argument into
// one is `validateCwd`'s job (application/cwd-validator.ts), done once per
// transport: REST's cwd-required middleware for this route (request-pipeline.ts)
// and, for MCP, the two tool handlers in mcp-adapter.ts, exactly as `mma_run`'s
// handleRun already validates its own `cwd` argument before calling the runtime.
// Re-validating an already-canonical path here would just be a second copy of
// that same call.

import type { ServerResponse } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { z } from 'zod';
import { sendError, sendJson } from '../../errors.js';
import type { RawHandler } from '../../types.js';
import type { ProjectRegistry, ReserveError } from '../../../application/project-registry.js';

interface ContextBlockHandlerDeps {
  projectRegistry: ProjectRegistry;
  maxContextBlockBytes: number;
  maxContextBlocksPerProject: number;
}

interface DeleteContextBlockHandlerDeps {
  projectRegistry: ProjectRegistry;
}

const createBodySchema = z.object({
  content: z.string().min(1),
  ttlMs: z.number().int().positive().optional(),
});

/** Error codes either operation can produce, verbatim across both transports —
 *  REST maps them onto HTTP status via `httpStatus`; MCP uses `code` + `message`
 *  + `extra` directly as a tool error result. `ReserveError` covers the (rare)
 *  case where the project registry itself rejects the reservation (e.g. the
 *  server hit its project cap between validation and reservation). */
type ContextBlockOpErrorCode = 'invalid_request' | 'payload_too_large' | 'cap_exhausted' | 'not_found' | 'pinned' | ReserveError;

interface ContextBlockOpError {
  ok: false;
  httpStatus: number;
  code: ContextBlockOpErrorCode;
  message: string;
  extra?: Record<string, unknown>;
}

type CreateContextBlockInput = {
  /** Already-canonical absolute project path — see the module-level note above. */
  cwd: string;
  content: unknown;
  ttlMs?: unknown;
};

type CreateContextBlockResult = { ok: true; id: string } | ContextBlockOpError;

type DeleteContextBlockInput = { cwd: string; blockId: string };

type DeleteContextBlockResult = { ok: true } | ContextBlockOpError;

/**
 * Validate the body, reserve the project, cap-check, and register a context
 * block. Plain arguments in, discriminated result out — no HTTP types. Shared
 * by `buildCreateContextBlockHandler` (REST) and the MCP `mma_context_block_create`
 * tool (mcp-adapter.ts).
 */
export function createContextBlock(deps: ContextBlockHandlerDeps, input: CreateContextBlockInput): CreateContextBlockResult {
  // ── 1. Validate body ─────────────────────────────────────────────────────
  const parsed = createBodySchema.safeParse({ content: input.content, ttlMs: input.ttlMs });
  if (!parsed.success) {
    return {
      ok: false,
      httpStatus: 400,
      code: 'invalid_request',
      message: 'Request body validation failed',
      extra: { fieldErrors: parsed.error.flatten() },
    };
  }
  const { content, ttlMs } = parsed.data;

  // ── 2. Content byte-size check ───────────────────────────────────────────
  const byteLen = Buffer.byteLength(content, 'utf8');
  if (byteLen > deps.maxContextBlockBytes) {
    return {
      ok: false,
      httpStatus: 413,
      code: 'payload_too_large',
      message: `Context block content exceeds the ${deps.maxContextBlockBytes}-byte limit (got ${byteLen} bytes)`,
    };
  }

  // ── 3. Reserve project ────────────────────────────────────────────────────
  const reserveResult = deps.projectRegistry.reserveProject(input.cwd);
  if (!reserveResult.ok) {
    return { ok: false, httpStatus: 503, code: reserveResult.error, message: reserveResult.message };
  }
  const pc = reserveResult.projectContext;
  pc.lastActivityAt = Date.now();
  deps.projectRegistry.cancelReservation(input.cwd);

  // ── 4. Cap check ──────────────────────────────────────────────────────────
  if (pc.contextBlocks.size >= deps.maxContextBlocksPerProject) {
    return {
      ok: false,
      httpStatus: 409,
      code: 'cap_exhausted',
      message: `Project context block cap of ${deps.maxContextBlocksPerProject} reached; delete unused blocks before creating new ones`,
    };
  }

  // ── 5. Register block directly ───────────────────────────────────────────
  // Forward the caller's per-block ttlMs when supplied; the store falls back to
  // its configured default (24h) when omitted.
  const registered = pc.contextBlocks.register(content, ttlMs !== undefined ? { ttlMs } : undefined);

  return { ok: true, id: registered.id };
}

/**
 * Delete a context block belonging to the given cwd. `not_found` when the
 * block does not exist or belongs to a different project (isolation);
 * `pinned` when it is still referenced by an active batch. Shared by
 * `buildDeleteContextBlockHandler` (REST) and the MCP `mma_context_block_delete`
 * tool (mcp-adapter.ts).
 */
export function deleteContextBlock(deps: DeleteContextBlockHandlerDeps, input: DeleteContextBlockInput): DeleteContextBlockResult {
  const { blockId } = input;

  // ── 1. Get project context ───────────────────────────────────────────────
  // Look up without reserving — we need to check if the project exists at all.
  const pc = deps.projectRegistry.get(input.cwd);
  if (!pc) {
    // Project doesn't exist — no blocks can belong to it.
    return { ok: false, httpStatus: 404, code: 'not_found', message: `Context block ${blockId} not found` };
  }

  // ── 2. Existence + isolation check ───────────────────────────────────────
  // Since contextBlocks is per-project, any block in pc.contextBlocks belongs
  // to this cwd. If the id isn't in this store, it either doesn't exist or
  // belongs to a different project — both map to not_found.
  const content = pc.contextBlocks.get(blockId);
  if (content === undefined) {
    return { ok: false, httpStatus: 404, code: 'not_found', message: `Context block ${blockId} not found` };
  }

  // ── 3. Pin check ──────────────────────────────────────────────────────────
  const refcount = pc.contextBlocks.refcount(blockId);
  if (refcount > 0) {
    return {
      ok: false,
      httpStatus: 409,
      code: 'pinned',
      message: `Context block ${blockId} is in use by ${refcount} active batch(es)`,
      extra: { refcount },
    };
  }

  // ── 4. Delete ─────────────────────────────────────────────────────────────
  pc.contextBlocks.delete(blockId);
  pc.lastActivityAt = Date.now();

  return { ok: true };
}

/**
 * POST /context-blocks — thin REST wrapper over `createContextBlock`. `ctx.cwd`
 * is already canonical by the time it reaches here (cwd-required middleware,
 * request-pipeline.ts).
 */
export function buildCreateContextBlockHandler(deps: ContextBlockHandlerDeps): RawHandler {
  return async (
    _req: IncomingMessage,
    res: ServerResponse,
    _params: Record<string, string>,
    ctx,
  ) => {
    const body = (ctx.body ?? {}) as { content?: unknown; ttlMs?: unknown };
    const result = createContextBlock(deps, { cwd: ctx.cwd!, content: body.content, ttlMs: body.ttlMs });
    if (!result.ok) {
      sendError(res, result.httpStatus, result.code, result.message, result.extra);
      return;
    }
    sendJson(res, 201, { id: result.id });
  };
}

/**
 * DELETE /context-blocks/:blockId — thin REST wrapper over `deleteContextBlock`.
 * `ctx.cwd` is already canonical (see note above).
 */
export function buildDeleteContextBlockHandler(deps: DeleteContextBlockHandlerDeps): RawHandler {
  return async (
    _req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
    ctx,
  ) => {
    const result = deleteContextBlock(deps, { cwd: ctx.cwd!, blockId: params.blockId! });
    if (!result.ok) {
      sendError(res, result.httpStatus, result.code, result.message, result.extra);
      return;
    }
    sendJson(res, 200, { ok: true });
  };
}
