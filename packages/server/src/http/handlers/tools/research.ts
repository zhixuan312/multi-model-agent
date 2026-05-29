import * as research from '@zhixuan92/multi-model-agent-core/tools/research/schema';
import { executeTask } from '@zhixuan92/multi-model-agent-core/lifecycle/task-executor';
import { toolConfig, type EnrichedResearchInput } from '@zhixuan92/multi-model-agent-core/tools/research/tool-config';
import { sendError, sendJson } from '../../errors.js';
import { asyncDispatch } from '../../async-dispatch.js';
import type { HandlerDeps } from '../../handler-deps.js';
import { emitRequestReceived } from '../../request-observability.js';
import type { RawHandler } from '../../types.js';

export function buildResearchHandler(deps: HandlerDeps): RawHandler {
  return async (_params, ctx) => {
    const parsed = research.inputSchema.safeParse(ctx.body);
    if (!parsed.success) {
      return sendError(400, 'invalid_request', 'Request body validation failed', {
        fieldErrors: parsed.error.flatten(),
      });
    }
    const input = parsed.data;
    const cwd = ctx.cwd!;

    const reserveResult = deps.projectRegistry.reserveProject(cwd);
    if (!reserveResult.ok) {
      return sendError(503, reserveResult.error, reserveResult.message);
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
      return sendError(400, 'context_block_not_found', 'one or more context block IDs do not exist', { missingBlocks });
    }

    const researchCfg = deps.config.research;
    const enrichedInput: EnrichedResearchInput = {
      ...input,
      resolvedContextBlocks,
      hasBrave: (researchCfg?.brave?.apiKeys?.length ?? 0) > 0,
    };

    const { batchId, statusUrl } = asyncDispatch({
      tool: 'research',
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

    await emitRequestReceived(deps, batchId, ctx.url.pathname + ctx.url.search, input);
    return sendJson(202, { batchId, statusUrl });
  };
}
