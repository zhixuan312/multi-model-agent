// packages/server/src/http/async-dispatch.ts
import { randomUUID } from 'node:crypto';
import type { BatchRegistry, ProjectContext } from '@zhixuan92/multi-model-agent-core';
import type { ExecutionContext } from '@zhixuan92/multi-model-agent-core';
import type { HandlerDeps } from './handler-deps.js';
import { buildExecutionContext } from './execution-context.js';

export interface AsyncDispatchOptions<TResult> {
  tool: string;
  projectCwd: string;
  blockIds: string[];
  batchRegistry: BatchRegistry;
  projectContext: ProjectContext;
  deps: HandlerDeps;
  /**
   * The async function that does the real work. Receives the ExecutionContext
   * and the pre-allocated batchId.
   */
  executor: (ctx: ExecutionContext, batchId: string) => Promise<TResult>;
}

export interface AsyncDispatchResult {
  batchId: string;
  statusUrl: string;
}

/**
 * Registers a new batch as 'pending', schedules the executor via setImmediate,
 * and returns immediately with { batchId, statusUrl }.
 *
 * On success: calls batchRegistry.complete(batchId, result).
 * On failure: calls batchRegistry.fail(batchId, { code, message, stack }).
 *
 * IMPORTANT: Does NOT maintain a manual activeBatches counter.
 * Use BatchRegistry.countActiveForProject(cwd) as the truth source.
 */
export function asyncDispatch<TResult>(
  opts: AsyncDispatchOptions<TResult>,
): AsyncDispatchResult {
  const batchId = randomUUID();
  const { batchRegistry, projectContext, deps, tool, projectCwd, blockIds } = opts;

  // Register entry as 'pending' before scheduling executor
  batchRegistry.register({
    batchId,
    projectCwd,
    tool,
    state: 'pending',
    startedAt: Date.now(),
    stateChangedAt: Date.now(),
    blockIds,
    blocksReleased: false,
  });

  // Build execution context for this batch
  const ctx = buildExecutionContext(deps, projectContext, batchId, tool);

  // Schedule executor asynchronously — do not await here
  const startedAtMs = Date.now();
  setImmediate(() => {
    void (async () => {
      try {
        deps.bus.emit({ event: 'task_started', ts: new Date().toISOString(), batchId, taskIndex: 0, route: tool, cwd: projectCwd } as any);
        // Mark the batch as running so /batch/:id polling reports
        // "1/1 running, Xs elapsed" the instant the executor begins.
        // Without bumping the headline snapshot here, the polling endpoint
        // returns the initial "0/N queued" fallback until the runner's first
        // heartbeat arrives — which can be many seconds (or minutes) later
        // because heartbeats fire from inside provider.run. That gap is what
        // made 4.0.1 audits look like the daemon was deadlocked when the
        // only thing actually slow was the LLM call.
        const entry = batchRegistry.get(batchId);
        if (entry) {
          entry.tasksTotal = 1;
          entry.tasksStarted = 1;
          entry.tasksCompleted = 0;
          batchRegistry.updateRunningHeadlineSnapshot(batchId, {
            prefix: `1/1 running, `,
            statsClause: ``,
            dispatchedAt: entry.runningHeadlineSnapshot.dispatchedAt,
            fallback: `1/1 running`,
          });
        }
        // Verbose-stderr breadcrumb so operators tailing the daemon see the
        // executor lifecycle past request_received without grepping the
        // JSONL log. Cheap; gated on diagnostics.verbose.
        if (deps.config.diagnostics?.verbose) {
          process.stdout.write(
            `[mmagent verbose] event=executor_started ts=${new Date().toISOString()} batch=${batchId} route=${tool}\n`,
          );
        }
        const result = await opts.executor(ctx, batchId);
        const resultObj = result as Record<string, unknown> | undefined;

        const entryAfter = batchRegistry.get(batchId);
        if (entryAfter) entryAfter.tasksCompleted = 1;
        batchRegistry.complete(batchId, result);
        const taskCount = Array.isArray(resultObj?.results) ? resultObj.results.length : 0;
        const durationMs = Date.now() - startedAtMs;
        deps.bus.emit({ event: 'batch_completed', ts: new Date().toISOString(), batchId, tool, durationMs, taskCount } as any);
        if (deps.config.diagnostics?.verbose) {
          process.stdout.write(
            `[mmagent verbose] event=batch_completed ts=${new Date().toISOString()} batch=${batchId} route=${tool} duration_ms=${durationMs}\n`,
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : undefined;
        batchRegistry.fail(batchId, {
          code: 'runner_crash',
          message,
          ...(stack !== undefined && { stack }),
        });
        const durationMs = Date.now() - startedAtMs;
        deps.bus.emit({ event: 'batch_failed', ts: new Date().toISOString(), batchId, tool, durationMs, errorCode: 'runner_crash', errorMessage: message } as any);
        if (deps.config.diagnostics?.verbose) {
          process.stdout.write(
            `[mmagent verbose] event=batch_failed ts=${new Date().toISOString()} batch=${batchId} route=${tool} duration_ms=${durationMs} error="${message.replace(/"/g, '\\"')}"\n`,
          );
        }
      }
    })();
  });

  return {
    batchId,
    statusUrl: `/batch/${batchId}`,
  };
}
