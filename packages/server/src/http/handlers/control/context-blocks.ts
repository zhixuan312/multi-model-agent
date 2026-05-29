// packages/server/src/http/handlers/control/context-blocks.ts
//
// Hosts POST /context-blocks (register) and DELETE /context-blocks/:id
// (unregister). Lives under handlers/control/ rather than handlers/tools/
// because register_context_block is an assist-tier sync state op:
//
//   - synchronous request/response (no batchId, no async dispatch)
//   - no LifecycleDispatcher path (no review chain, no commit stage)
//   - paired skill is mma-context-blocks/ (covers register + lookup)
//
// See vertical_design.md §9 "register_context_block / Assist-tier slot
// conventions" for the canonical rationale.
//
// v4.0: POST /context-blocks is now a thin shim that validates, reserves
// the project, and dispatches to the LifecycleDispatcher (which routes
// through the register_to_block_store stage handler per the StagePlan).

import { z } from 'zod';
import { sendError, sendJson } from '../../errors.js';
import type { RawHandler } from '../../types.js';
import type { ProjectRegistry } from '../../project-registry.js';
import { LifecycleDispatcher } from '@zhixuan92/multi-model-agent-core';

export interface ContextBlockHandlerDeps {
  projectRegistry: ProjectRegistry;
  maxContextBlockBytes: number;
  maxContextBlocksPerProject: number;
}

export interface DeleteContextBlockHandlerDeps {
  projectRegistry: ProjectRegistry;
}

const createBodySchema = z.object({
  content: z.string().min(1),
  ttlMs: z.number().int().positive().optional(),
});

/**
 * POST /context-blocks — thin shim that validates, reserves the project,
 * and delegates block registration to the LifecycleDispatcher StagePlan.
 */
export function buildCreateContextBlockHandler(deps: ContextBlockHandlerDeps): RawHandler {
  return async (_params, ctx) => {
    const cwd = ctx.cwd!;

    // ── 1. Validate body ───────────────────────────────────────────────────
    const parsed = createBodySchema.safeParse(ctx.body);
    if (!parsed.success) {
      return sendError(400, 'invalid_request', 'Request body validation failed', {
        fieldErrors: parsed.error.flatten(),
      });
    }

    const { content } = parsed.data;

    // ── 2. Content byte-size check ─────────────────────────────────────────
    const byteLen = Buffer.byteLength(content, 'utf8');
    if (byteLen > deps.maxContextBlockBytes) {
      return sendError(
        413,
        'payload_too_large',
        `Context block content exceeds the ${deps.maxContextBlockBytes}-byte limit (got ${byteLen} bytes)`,
      );
    }

    // ── 3. Reserve project ─────────────────────────────────────────────────
    const reserveResult = deps.projectRegistry.reserveProject(cwd);
    if (!reserveResult.ok) {
      return sendError(503, reserveResult.error, reserveResult.message);
    }
    const pc = reserveResult.projectContext;
    pc.lastActivityAt = Date.now();
    deps.projectRegistry.cancelReservation(cwd);

    // ── 4. Cap check ───────────────────────────────────────────────────────
    if (pc.contextBlocks.size >= deps.maxContextBlocksPerProject) {
      return sendError(
        409,
        'cap_exhausted',
        `Project context block cap of ${deps.maxContextBlocksPerProject} reached; delete unused blocks before creating new ones`,
      );
    }

    // ── 5. Dispatch to lifecycle ───────────────────────────────────────────
    const dispatcher = new LifecycleDispatcher();
    const output = await dispatcher.dispatch({
      route: 'register-context-block',
      toolCategory: 'assist',
      rawRequest: parsed.data,
      context: { projectContext: pc },
    });

    // ── 6. Return dispatcher output ────────────────────────────────────────
    const status = output.status === 200 ? 201 : output.status;
    return sendJson(status as 200 | 201 | 400 | 409, output.body);
  };
}

/**
 * DELETE /context-blocks/:blockId — removes a context block belonging to the
 * authenticated cwd. Returns 404 if the block does not exist or belongs to
 * a different project (isolation).
 */
export function buildDeleteContextBlockHandler(deps: DeleteContextBlockHandlerDeps): RawHandler {
  return async (params, ctx) => {
    const cwd = ctx.cwd!;
    const { blockId } = params;

    // ── 1. Get project context ─────────────────────────────────────────────
    // Look up without reserving — we need to check if the project exists at all
    const pc = deps.projectRegistry.get(cwd);
    if (!pc) {
      // Project doesn't exist — no blocks can belong to it
      return sendError(404, 'not_found', `Context block ${blockId} not found`);
    }

    // ── 2. Existence + isolation check ─────────────────────────────────────
    // Since contextBlocks is per-project, any block in pc.contextBlocks belongs
    // to this cwd. If the id isn't in this store, it either doesn't exist or
    // belongs to a different project — both map to 404.
    const content = pc.contextBlocks.get(blockId);
    if (content === undefined) {
      return sendError(404, 'not_found', `Context block ${blockId} not found`);
    }

    // ── 3. Pin check ───────────────────────────────────────────────────────
    const refcount = pc.contextBlocks.refcount(blockId);
    if (refcount > 0) {
      return sendError(409, 'pinned', `Context block ${blockId} is in use by ${refcount} active batch(es)`, { refcount });
    }

    // ── 4. Delete ──────────────────────────────────────────────────────────
    pc.contextBlocks.delete(blockId);
    pc.lastActivityAt = Date.now();

    return sendJson(200, { ok: true });
  };
}
