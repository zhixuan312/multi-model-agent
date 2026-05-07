import * as path from 'node:path';
import { realpathSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as explore from '@zhixuan92/multi-model-agent-core/tools/explore/schema';
import { executeExplore } from '@zhixuan92/multi-model-agent-core/research/explore-orchestrator';
import { sendError, sendJson } from '../../errors.js';
import { asyncDispatch } from '../../async-dispatch.js';
import type { HandlerDeps } from '../../handler-deps.js';
import { emitRequestReceived } from '../../request-observability.js';
import type { RawHandler } from '../../types.js';
import { canonicalizeFilePaths } from '../../canonicalize-file-paths.js';
export function buildExploreHandler(deps: HandlerDeps): RawHandler {
  return async (req: IncomingMessage, res: ServerResponse, _params, ctx) => {
    const parsed = explore.inputSchema.safeParse(ctx.body);
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

    const rawPaths = input.anchors ?? [];
    const canonResult = canonicalizeFilePaths(rawPaths, cwd);
    if (!Array.isArray(canonResult)) {
      sendError(res, 400, 'invalid_request', 'one or more anchors escape cwd', { fieldErrors: canonResult.fieldErrors });
      return;
    }
    const canonicalizedAnchors = canonResult;

    const realCwd = realpathSync(cwd);
    const relativeAnchorsForPrompt = canonicalizedAnchors.map(p => {
      const rel = path.relative(realCwd, p);
      return rel === '' ? '.' : rel;
    });

    const { batchId, statusUrl } = asyncDispatch({
      tool: 'explore',
      projectCwd: cwd,
      blockIds,
      batchRegistry: deps.batchRegistry,
      projectContext: pc,
      deps,
      caller: { client: ctx.callerClient, mainModel: ctx.mainModel },
      executor: async (executionCtx) => {
        const callExecutor = () => executeExplore(executionCtx, {
          input,
          resolvedContextBlocks,
          canonicalizedAnchors,
          relativeAnchorsForPrompt,
        });
        if (deps.routeDispatcher) {
          const result = await deps.routeDispatcher.dispatch({
            route: 'explore',
            toolCategory: 'research',
            rawRequest: input,
            executor: () => callExecutor(),
          });
          return result.body;
        }
        return callExecutor();
      },
    });

    await emitRequestReceived({ config: deps.config, batchId, route: req.url ?? '', parsed: input });
    sendJson(res, 202, { batchId, statusUrl });
  };
}
