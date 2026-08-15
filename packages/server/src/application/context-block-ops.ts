// The two context-block state operations, shared by both transports.
//
// Plain arguments in, a discriminated result out — no IncomingMessage/ServerResponse and no HTTP
// status codes anywhere near them. Body validation, byte limits, project caps, pin checks, and the
// mutations themselves exist in exactly one place: here.
//
// These used to live in `http/handlers/control/context-blocks.ts`, whose own header explained the
// design well: the REST handlers are thin wrappers, and the MCP adapter "calls the SAME two
// operations directly — it has no request/response pair to hand a RawHandler, so operating on plain
// arguments is what makes it a caller instead of a second implementation." That reasoning is right
// and unchanged. The problem was only WHERE the shared code sat: `mcp/mcp-adapter.ts` had to import
// from `http/handlers/`, which contradicts the layering CLAUDE.md states — "http/ … depends one-way
// on application/". Two sibling transports, one importing the other, is the shape that later makes
// someone copy the logic rather than reach across.
//
// The error result carries a `code`, not an `httpStatus`: mapping a code onto a status is the REST
// adapter's business (`contextBlockErrorToHttp`), exactly as `initiativeErrorToHttp` already maps
// the shared Initiative classification for that route. MCP never read `httpStatus` — it uses
// `code` + `message` + `extra` — so nothing is lost by keeping it out of here.
//
// `cwd` arrives ALREADY CANONICAL — resolving a raw cwd argument is `validateCwd`'s job
// (cwd-validator.ts), done once per transport: REST's cwd-required middleware for this route
// (request-pipeline.ts) and, for MCP, the two tool handlers in mcp-adapter.ts, exactly as
// `mma_run`'s `handleRun` validates its own `cwd` before calling the runtime. Re-validating an
// already-canonical path here would just be a second copy of that call.

import { z } from 'zod';
import type { ProjectRegistry, ReserveError } from './project-registry.js';

export interface ContextBlockOpDeps {
  projectRegistry: ProjectRegistry;
  maxContextBlockBytes: number;
  maxContextBlocksPerProject: number;
}

export interface DeleteContextBlockOpDeps {
  projectRegistry: ProjectRegistry;
}

const createBodySchema = z.object({
  content: z.string().min(1),
  ttlMs: z.number().int().positive().optional(),
});

/** Error codes either operation can produce, verbatim across both transports. `ReserveError` covers
 *  the (rare) case where the project registry itself rejects the reservation — e.g. the server hit
 *  its project cap between validation and reservation. */
export type ContextBlockOpErrorCode =
  | 'invalid_request' | 'payload_too_large' | 'cap_exhausted' | 'not_found' | 'pinned' | ReserveError;

export interface ContextBlockOpError {
  ok: false;
  code: ContextBlockOpErrorCode;
  message: string;
  extra?: Record<string, unknown>;
}

export type CreateContextBlockInput = {
  /** Already-canonical absolute project path — see the module note above. */
  cwd: string;
  content: unknown;
  ttlMs?: unknown;
};

export type CreateContextBlockResult = { ok: true; id: string } | ContextBlockOpError;

export type DeleteContextBlockInput = { cwd: string; blockId: string };

export type DeleteContextBlockResult = { ok: true } | ContextBlockOpError;

/**
 * Validate the body, reserve the project, cap-check, and register a context block.
 */
export function createContextBlock(
  deps: ContextBlockOpDeps,
  input: CreateContextBlockInput,
): CreateContextBlockResult {
  // ── 1. Validate body ─────────────────────────────────────────────────────
  const parsed = createBodySchema.safeParse({ content: input.content, ttlMs: input.ttlMs });
  if (!parsed.success) {
    return {
      ok: false,
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
      code: 'payload_too_large',
      message: `Context block content exceeds the ${deps.maxContextBlockBytes}-byte limit (got ${byteLen} bytes)`,
    };
  }

  // ── 3. Reserve project ────────────────────────────────────────────────────
  const reserveResult = deps.projectRegistry.reserveProject(input.cwd);
  if (!reserveResult.ok) {
    return { ok: false, code: reserveResult.error, message: reserveResult.message };
  }
  const pc = reserveResult.projectContext;
  pc.lastActivityAt = Date.now();

  // ── 4. Cap check ──────────────────────────────────────────────────────────
  if (pc.contextBlocks.size >= deps.maxContextBlocksPerProject) {
    return {
      ok: false,
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
 * Delete a context block belonging to the given cwd. `not_found` when the block does not exist or
 * belongs to a different project (isolation); `pinned` when it is still referenced by an active
 * batch.
 */
export function deleteContextBlock(
  deps: DeleteContextBlockOpDeps,
  input: DeleteContextBlockInput,
): DeleteContextBlockResult {
  const { blockId } = input;

  // ── 1. Get project context ───────────────────────────────────────────────
  // Look up without reserving — we need to check if the project exists at all.
  const pc = deps.projectRegistry.get(input.cwd);
  if (!pc) {
    // Project doesn't exist — no blocks can belong to it.
    return { ok: false, code: 'not_found', message: `Context block ${blockId} not found` };
  }

  // ── 2. Existence + isolation check ───────────────────────────────────────
  // Since contextBlocks is per-project, any block in pc.contextBlocks belongs
  // to this cwd. If the id isn't in this store, it either doesn't exist or
  // belongs to a different project — both map to not_found.
  // `has`, not `get`: `get` refreshes the entry's TTL and LRU position, so asking whether a block
  // exists in order to DELETE it used to extend its life and make it the last thing evicted.
  if (!pc.contextBlocks.has(blockId)) {
    return { ok: false, code: 'not_found', message: `Context block ${blockId} not found` };
  }

  // ── 3. Pin check ──────────────────────────────────────────────────────────
  const refcount = pc.contextBlocks.refcount(blockId);
  if (refcount > 0) {
    return {
      ok: false,
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
