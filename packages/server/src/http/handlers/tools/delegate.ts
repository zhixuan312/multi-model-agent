// packages/server/src/http/handlers/tools/delegate.ts
import type { ServerResponse } from 'node:http';
import type { IncomingMessage } from 'node:http';
import * as delegate from '@zhixuan92/multi-model-agent-core/tool-schemas/delegate';
import { executeDelegate } from '@zhixuan92/multi-model-agent-core/executors/delegate';
import type { MultiModelConfig, TaskSpec } from '@zhixuan92/multi-model-agent-core';
import { sendError, sendJson } from '../../errors.js';
import { asyncDispatch } from '../../async-dispatch.js';
import type { HandlerDeps } from '../../handler-deps.js';
import type { RawHandler } from '../../router.js';

/** Builds injectDefaults for delegate/retry — fills harness-level TaskSpec fields from config. */
function makeInjectDefaults(config: MultiModelConfig, cwd: string): (tasks: TaskSpec[]) => TaskSpec[] {
  return (tasks: TaskSpec[]) =>
    tasks.map(t => ({
      ...t,
      cwd: t.cwd ?? cwd,
      tools: t.tools ?? config.defaults?.tools ?? 'full',
      timeoutMs: t.timeoutMs ?? config.defaults?.timeoutMs ?? 1_800_000,
      maxCostUSD: t.maxCostUSD ?? config.defaults?.maxCostUSD ?? 10,
      sandboxPolicy: t.sandboxPolicy ?? config.defaults?.sandboxPolicy ?? 'cwd-only',
      parentModel: t.parentModel ?? config.defaults?.parentModel ?? process.env['PARENT_MODEL_NAME'],
    }));
}

export function buildDelegateHandler(deps: HandlerDeps): RawHandler {
  return async (_req: IncomingMessage, res: ServerResponse, _params: Record<string, string>, ctx) => {
    // Step 7: Validate body against delegate.inputSchema
    const parsed = delegate.inputSchema.safeParse(ctx.body);
    if (!parsed.success) {
      sendError(res, 400, 'invalid_request', 'Request body validation failed', {
        fieldErrors: parsed.error.flatten(),
      });
      return;
    }

    const input = parsed.data;
    const cwd = ctx.cwd!;

    // Step 8: Get or create project context, update activity timestamp
    const reserveResult = deps.projectRegistry.reserveProject(cwd);
    if (!reserveResult.ok) {
      sendError(res, 503, reserveResult.error, reserveResult.message);
      return;
    }
    const pc = reserveResult.projectContext;
    pc.lastActivityAt = Date.now();
    // Release the reservation (HTTP requests are not session-based)
    deps.projectRegistry.cancelReservation(cwd);

    // Step 9: Async-dispatch
    const blockIds = input.tasks.flatMap(t => t.contextBlockIds ?? []);
    const { batchId, statusUrl } = asyncDispatch({
      tool: 'delegate',
      projectCwd: cwd,
      blockIds,
      batchRegistry: deps.batchRegistry,
      projectContext: pc,
      deps,
      executor: async (executionCtx) => {
        return executeDelegate(executionCtx, input, {
          injectDefaults: makeInjectDefaults(deps.config, cwd),
        });
      },
    });

    sendJson(res, 202, { batchId, statusUrl });
  };
}
