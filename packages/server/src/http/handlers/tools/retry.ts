// packages/server/src/http/handlers/tools/retry.ts
//
// PUBLIC retry route — POST /retry. Goes through the LifecycleDispatcher
// when the original batch's toolCategory is recoverable, otherwise falls
// back to the legacy executor path. This is the route called by the
// `mma-retry` skill and end-user clients.
//
// SEE ALSO: handlers/control/retry.ts is the protocol-level twin
// registered at /control/retry — same executor, but synchronous batch
// validation (404s when the batchId is unknown) and no dispatcher path.
// The two endpoints exist because the public skill expects async-202
// semantics while the control surface expects sync validation feedback.
import type { ServerResponse } from 'node:http';
import type { IncomingMessage } from 'node:http';
import * as retry from '@zhixuan92/multi-model-agent-core/tools/retry/schema';
import { executeRetry } from '@zhixuan92/multi-model-agent-core/lifecycle/executors/retry';
import type { MultiModelConfig, TaskSpec } from '@zhixuan92/multi-model-agent-core';
import { sendError, sendJson } from '../../errors.js';
import { asyncDispatch } from '../../async-dispatch.js';
import type { HandlerDeps } from '../../handler-deps.js';
import type { RawHandler } from '../../types.js';

/** Same inject-defaults logic as delegate — fills harness fields from config. */
function makeInjectDefaults(config: MultiModelConfig, cwd: string): (tasks: TaskSpec[]) => TaskSpec[] {
  return (tasks: TaskSpec[]) =>
    tasks.map(t => ({
      ...t,
      cwd: t.cwd ?? cwd,
      tools: t.tools ?? config.defaults?.tools ?? 'full',
      timeoutMs: t.timeoutMs ?? config.defaults?.timeoutMs ?? 1_800_000,
      maxCostUSD: t.maxCostUSD ?? config.defaults?.maxCostUSD ?? 10,
      sandboxPolicy: t.sandboxPolicy ?? config.defaults?.sandboxPolicy ?? 'cwd-only',
      mainModel: t.mainModel ?? config.defaults?.mainModel ?? process.env['PARENT_MODEL_NAME'],
    }));
}

export function buildRetryHandler(deps: HandlerDeps): RawHandler {
  return async (_req: IncomingMessage, res: ServerResponse, _params: Record<string, string>, ctx) => {
    const parsed = retry.inputSchema.safeParse(ctx.body);
    if (!parsed.success) {
      sendError(res, 400, 'invalid_request', 'Request body validation failed', {
        fieldErrors: parsed.error.flatten(),
      });
      return;
    }

    const input = parsed.data;
    const cwd = ctx.cwd!;

    // Resolve original batch's toolCategory for dispatcher budget selection.
    // Missing-batch and invalid-category cases fall through to the legacy
    // executor path (which surfaces the error asynchronously inside the
    // batch result) — matching pre-cutover behavior where retry's 202 was
    // unconditional and validation happened lazily.
    let originalToolCategory: 'artifact_producing' | 'read_only' | 'research' | undefined;
    if (deps.routeDispatcher) {
      const original = deps.batchRegistry.get(input.batchId);
      if (
        original
        && original.toolCategory
        && (original.toolCategory as string) !== 'assist'
      ) {
        originalToolCategory = original.toolCategory as typeof originalToolCategory;
      }
    }

    const reserveResult = deps.projectRegistry.reserveProject(cwd);
    if (!reserveResult.ok) {
      sendError(res, 503, reserveResult.error, reserveResult.message);
      return;
    }
    const pc = reserveResult.projectContext;
    pc.lastActivityAt = Date.now();
    deps.projectRegistry.cancelReservation(cwd);

    const { batchId, statusUrl } = asyncDispatch({
      tool: 'retry',
      projectCwd: cwd,
      blockIds: [],
      batchRegistry: deps.batchRegistry,
      projectContext: pc,
      deps,
      executor: async (executionCtx) => {
        const callExecutor = () => executeRetry(executionCtx, input, {
          injectDefaults: makeInjectDefaults(deps.config, cwd),
        });
        if (deps.routeDispatcher && originalToolCategory) {
          const result = await deps.routeDispatcher.dispatch({
            route: 'retry',
            toolCategory: originalToolCategory,
            rawRequest: { batchId: input.batchId, retryableFor: input.taskIndices, cwd },
            executor: () => callExecutor(),
          });
          return result.body;
        }
        return callExecutor();
      },
    });

    sendJson(res, 202, { batchId, statusUrl });
  };
}
