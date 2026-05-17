import * as path from 'node:path';
import { realpathSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as investigate from '@zhixuan92/multi-model-agent-core/tools/investigate/schema';
import { executeTask } from '@zhixuan92/multi-model-agent-core/lifecycle/task-executor';
import { toolConfig, type EnrichedInvestigateInput } from '@zhixuan92/multi-model-agent-core/tools/investigate/tool-config';
import { sendError, sendJson } from '../../errors.js';
import { asyncDispatch } from '../../async-dispatch.js';
import type { HandlerDeps } from '../../handler-deps.js';
import { emitRequestReceived } from '../../request-observability.js';
import type { RawHandler } from '../../types.js';
import { canonicalizeFilePaths } from '../../canonicalize-file-paths.js';

export function buildInvestigateHandler(deps: HandlerDeps): RawHandler {
  return async (_req: IncomingMessage, res: ServerResponse, _params, ctx) => {
    const parsed = investigate.inputSchema.safeParse(ctx.body);
    if (!parsed.success) {
      sendError(res, 400, 'invalid_request', 'Request body validation failed', {
        fieldErrors: parsed.error.flatten(),
      });
      return;
    }
    const input = parsed.data;
    const cwd = ctx.cwd!;

    const reserveResult = deps.projectRegistry.reserveProject(cwd);
    if (!reserveResult.ok) {
      sendError(res, 503, reserveResult.error, reserveResult.message);
      return;
    }
    const pc = reserveResult.projectContext;
    pc.lastActivityAt = Date.now();
    deps.projectRegistry.cancelReservation(cwd);

    // Resolve context blocks.
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

    // Canonicalize file paths.
    const rawPaths = input.filePaths ?? [];
    const canonResult = canonicalizeFilePaths(rawPaths, cwd);
    if (!Array.isArray(canonResult)) {
      sendError(res, 400, 'invalid_request', 'one or more filePaths escape cwd', { fieldErrors: canonResult.fieldErrors });
      return;
    }
    const canonicalizedFilePaths = canonResult;

    // Pre-compute relative paths for prompt.
    const realCwd = realpathSync(cwd);
    const relativeFilePathsForPrompt = canonicalizedFilePaths.map(p => {
      const rel = path.relative(realCwd, p);
      return rel === '' ? '.' : rel;
    });

    // Build enriched input for the generic task executor.
    const enrichedInput: EnrichedInvestigateInput = {
      ...input,
      resolvedContextBlocks,
      canonicalizedFilePaths,
      relativeFilePathsForPrompt,
    };

    const { batchId, statusUrl } = asyncDispatch({
      tool: 'investigate',
      projectCwd: cwd,
      blockIds,
      batchRegistry: deps.batchRegistry,
      projectContext: pc,
      deps,
      caller: { client: ctx.callerClient, mainModel: ctx.mainModel },
      executor: async (executionCtx) => {
        return executeTask(toolConfig, executionCtx, enrichedInput);
      },
    });

    await emitRequestReceived(deps, batchId, _req.url ?? '', input);
    sendJson(res, 202, { batchId, statusUrl });
  };
}
