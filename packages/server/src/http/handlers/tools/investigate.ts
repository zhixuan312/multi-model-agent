// packages/server/src/http/handlers/tools/investigate.ts
import * as path from 'node:path';
import { realpathSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as investigate from '@zhixuan92/multi-model-agent-core/tool-schemas/investigate';
import { executeInvestigate } from '@zhixuan92/multi-model-agent-core/executors/investigate';
import { sendError, sendJson } from '../../errors.js';
import { asyncDispatch } from '../../async-dispatch.js';
import type { HandlerDeps } from '../../handler-deps.js';
import { emitRequestReceived } from '../../request-observability.js';
import type { RawHandler } from '../../router.js';
import { canonicalizeFilePaths } from '../../canonicalize-file-paths.js';

export function buildInvestigateHandler(deps: HandlerDeps): RawHandler {
  return async (req: IncomingMessage, res: ServerResponse, _params, ctx) => {
    // Step 1: schema.
    const parsed = investigate.inputSchema.safeParse(ctx.body);
    if (!parsed.success) {
      sendError(res, 400, 'invalid_request', 'Request body validation failed', {
        fieldErrors: parsed.error.flatten(),
      });
      return;
    }
    const input = parsed.data;
    const cwd = ctx.cwd!;

    // Step 2: reservation lifecycle (mirrors audit.ts; reservation is just a cwd-validity gate).
    const reserveResult = deps.projectRegistry.reserveProject(cwd);
    if (!reserveResult.ok) {
      sendError(res, 503, reserveResult.error, reserveResult.message);
      return;
    }
    const pc = reserveResult.projectContext;
    pc.lastActivityAt = Date.now();
    deps.projectRegistry.cancelReservation(cwd);

    // Step 3: synchronously resolve context blocks.
    const blockIds = input.contextBlockIds ?? [];
    const resolvedContextBlocks: Array<{ id: string; content: string }> = [];
    const missingBlocks: string[] = [];
    for (const id of blockIds) {
      const content = pc.contextBlocks.get(id);
      if (content === undefined) {
        missingBlocks.push(id);
      } else {
        resolvedContextBlocks.push({ id, content });
      }
    }
    if (missingBlocks.length > 0) {
      sendError(res, 400, 'context_block_not_found', 'one or more context block IDs do not exist', { missingBlocks });
      return;
    }

    // Step 4: synchronously canonicalize filePaths.
    const rawPaths = input.filePaths ?? [];
    const canonResult = canonicalizeFilePaths(rawPaths, cwd);
    if (!Array.isArray(canonResult)) {
      sendError(res, 400, 'invalid_request', 'one or more filePaths escape cwd', { fieldErrors: canonResult.fieldErrors });
      return;
    }
    const canonicalizedFilePaths = canonResult;

    // Step 5: precompute relative-for-prompt paths so the compiler stays pure.
    const realCwd = realpathSync(cwd);
    const relativeFilePathsForPrompt = canonicalizedFilePaths.map(p => {
      const rel = path.relative(realCwd, p);
      return rel === '' ? '.' : rel;
    });

    // Step 6: dispatch.
    const { batchId, statusUrl } = asyncDispatch({
      tool: 'investigate',
      projectCwd: cwd,
      blockIds,
      batchRegistry: deps.batchRegistry,
      projectContext: pc,
      deps,
      executor: async (executionCtx) => executeInvestigate(executionCtx, {
        input,
        resolvedContextBlocks,
        canonicalizedFilePaths,
        relativeFilePathsForPrompt,
      }),
    });

    await emitRequestReceived({ config: deps.config, batchId, route: req.url ?? '', parsed: input });
    sendJson(res, 202, { batchId, statusUrl });
  };
}
