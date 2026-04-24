// packages/server/src/http/handlers/control/context-blocks.ts
import type { ServerResponse } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { z } from 'zod';
import { sendError, sendJson } from '../../errors.js';
import type { RawHandler } from '../../router.js';
import type { ProjectRegistry } from '../../project-registry.js';
import type { ServerConfig } from '@zhixuan92/multi-model-agent-core';

export interface ContextBlockHandlerDeps {
  projectRegistry: ProjectRegistry;
  config: ServerConfig;
}

export interface DeleteContextBlockHandlerDeps {
  projectRegistry: ProjectRegistry;
}

const createBodySchema = z.object({
  content: z.string().min(1),
  ttlMs: z.number().int().positive().optional(),
});

/**
 * POST /context-blocks — stores a new context block for the authenticated cwd.
 * Requires cwd query param (cwd-gated).
 */
export function buildCreateContextBlockHandler(deps: ContextBlockHandlerDeps): RawHandler {
  return async (
    _req: IncomingMessage,
    res: ServerResponse,
    _params: Record<string, string>,
    ctx,
  ) => {
    const cwd = ctx.cwd!;

    // ── 1. Validate body ───────────────────────────────────────────────────
    const parsed = createBodySchema.safeParse(ctx.body);
    if (!parsed.success) {
      sendError(res, 400, 'invalid_request', 'Request body validation failed', {
        fieldErrors: parsed.error.flatten(),
      });
      return;
    }

    const { content } = parsed.data;

    // ── 2. Content byte-size check ─────────────────────────────────────────
    const byteLen = Buffer.byteLength(content, 'utf8');
    const maxBytes = deps.config.server.limits.maxContextBlockBytes;
    if (byteLen > maxBytes) {
      sendError(
        res,
        413,
        'payload_too_large',
        `Context block content exceeds the ${maxBytes}-byte limit (got ${byteLen} bytes)`,
      );
      return;
    }

    // ── 3. Get project context ─────────────────────────────────────────────
    const reserveResult = deps.projectRegistry.reserveProject(cwd);
    if (!reserveResult.ok) {
      sendError(res, 503, reserveResult.error, reserveResult.message);
      return;
    }
    const pc = reserveResult.projectContext;
    pc.lastActivityAt = Date.now();
    deps.projectRegistry.cancelReservation(cwd);

    // ── 4. Cap check ───────────────────────────────────────────────────────
    const maxBlocks = deps.config.server.limits.maxContextBlocksPerProject;
    if (pc.contextBlocks.size >= maxBlocks) {
      sendError(
        res,
        409,
        'cap_exhausted',
        `Project context block cap of ${maxBlocks} reached; delete unused blocks before creating new ones`,
      );
      return;
    }

    // ── 5. Create block ────────────────────────────────────────────────────
    const registered = pc.contextBlocks.register(content);

    sendJson(res, 201, { id: registered.id });
  };
}

/**
 * DELETE /context-blocks/:blockId — removes a context block belonging to the
 * authenticated cwd. Returns 404 if the block does not exist or belongs to
 * a different project (isolation).
 */
export function buildDeleteContextBlockHandler(deps: DeleteContextBlockHandlerDeps): RawHandler {
  return async (
    _req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
    ctx,
  ) => {
    const cwd = ctx.cwd!;
    const { blockId } = params;

    // ── 1. Get project context ─────────────────────────────────────────────
    // Look up without reserving — we need to check if the project exists at all
    const pc = deps.projectRegistry.get(cwd);
    if (!pc) {
      // Project doesn't exist — no blocks can belong to it
      sendError(res, 404, 'not_found', `Context block ${blockId} not found`);
      return;
    }

    // ── 2. Existence + isolation check ─────────────────────────────────────
    // Since contextBlocks is per-project, any block in pc.contextBlocks belongs
    // to this cwd. If the id isn't in this store, it either doesn't exist or
    // belongs to a different project — both map to 404.
    const content = pc.contextBlocks.get(blockId);
    if (content === undefined) {
      sendError(res, 404, 'not_found', `Context block ${blockId} not found`);
      return;
    }

    // ── 3. Pin check ───────────────────────────────────────────────────────
    const refcount = pc.contextBlocks.refcount(blockId);
    if (refcount > 0) {
      sendError(res, 409, 'pinned', `Context block ${blockId} is in use by ${refcount} active batch(es)`, { refcount });
      return;
    }

    // ── 4. Delete ──────────────────────────────────────────────────────────
    pc.contextBlocks.delete(blockId);
    pc.lastActivityAt = Date.now();

    sendJson(res, 200, { ok: true });
  };
}
