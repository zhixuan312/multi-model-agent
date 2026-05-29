// packages/server/src/http/async-dispatch.ts
import { randomUUID } from 'node:crypto';
import type { BatchRegistry, ProjectContext } from '@zhixuan92/multi-model-agent-core';
import type { ExecutionContext } from '@zhixuan92/multi-model-agent-core';
import { TaskEnvelopeStore } from '@zhixuan92/multi-model-agent-core/events/task-envelope';
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
   * Caller identity from the x-mma-client request header. Threaded into
   * ExecutionContext so the cloud `task.completed` event carries the client.
   * Without this the wire event has an empty string and the backend rejects
   * the upload (STRICT_ID_REGEX). triggeringSkill was dropped because it's
   * implied by `route` for the 99% case (mma-<route> → /<route>).
   */
  caller?: { client: string; mainModel?: string | null };
  reviewPolicy?: 'full' | 'quality_only' | 'diff_only' | 'none';
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

  // Create and attach envelope to registry
  const envelope = TaskEnvelopeStore.create({
    taskId: batchId + ':' + 0,
    batchId: batchId, taskIndex: 0,
    route: tool as any, agentType: 'standard',
    client: opts.caller?.client ?? '', mainModel: opts.caller?.mainModel ?? '', cwd: projectCwd,
    reviewPolicy: opts.reviewPolicy ?? 'full',
  }, deps.bus);
  batchRegistry.attachEnvelope(batchId, 0, envelope);

  // Build execution context for this batch
  const ctx = buildExecutionContext(deps, projectContext, batchId, envelope, tool, opts.caller);

  // Schedule executor asynchronously — do not await here
  const startedAtMs = Date.now();
  setImmediate(() => {
    void (async () => {
      try {
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
          // Use the route's stage-order denominator (3 for audit, 7 for
          // delegate, etc.) so polling shows "Implementing (1/3)" the
          // instant the executor starts — instead of an opaque
          // "1/1 running" that doesn't tell the main agent how far along
          // the lifecycle has progressed.
          // Headline seeding moved to envelope creation in T7-T11 migration —
          // each TaskEnvelope's headline is derived on every mutation, and
          // BatchRegistry no longer caches snapshot objects.
        }
        // 4.6.0+: always-on verbose breadcrumb so operators tailing the daemon
        // see the executor lifecycle past request_received without grepping the
        // JSONL log.
        process.stderr.write(
          `[mmagent] event=executor_started ts=${new Date().toISOString()} batch=${batchId} route=${tool}\n`,
        );
        const result = await opts.executor(ctx, batchId);
        const resultObj = result as Record<string, unknown> | undefined;

        const entryAfter = batchRegistry.get(batchId);
        if (entryAfter) {
          // For multi-task batches the executor bumped tasksTotal from the
          // placeholder of 1 to the real fan-out width. Mark every task as
          // completed so the live/terminal headline reports n/n complete.
          entryAfter.tasksCompleted = Math.max(entryAfter.tasksTotal ?? 1, 1);
        }
        const taskCount = Array.isArray(resultObj?.results) ? resultObj.results.length : 0;
        const durationMs = Date.now() - startedAtMs;

        // Gap 5 fix (4.0.3+): inspect the envelope for structured failure
        // signals. The executor may catch errors and package them into a
        // result envelope (with structuredError or status='error') instead
        // of throwing — without this check, batch_completed fires
        // misleadingly while the verbose log gives operators no signal
        // that anything went wrong. Detection uses STRUCTURED FIELDS ONLY,
        // never string comparisons.
        //
        // Order matters: detect failure FIRST, then call complete() or
        // fail() exactly once. Pre-fix, complete() ran unconditionally
        // before fail() — the fail() then no-op'd because the registry
        // entry was already terminal, leaving the wire error field stuck
        // at "not_applicable" even when detectFailure returned a real
        // failure. Probe I (multi-task /delegate) hit this every time.
        const failure = detectFailure(resultObj);
        if (failure) {
          batchRegistry.fail(batchId, failure);
          deps.bus.emitPlainEntry({ ts: new Date().toISOString(), kind: 'batch_failed', fields: { batch_id: batchId, tool, duration_ms: durationMs, error_code: failure.code, error_message: failure.message } });
          process.stderr.write(
            `[mmagent] event=batch_failed ts=${new Date().toISOString()} batch=${batchId} route=${tool} duration_ms=${durationMs} error_code=${failure.code} error="${failure.message.replace(/"/g, '\\"')}"\n`,
          );
        } else {
          batchRegistry.complete(batchId);
          const dispatchMode = (resultObj as { dispatchMode?: string } | undefined)?.dispatchMode;
          deps.bus.emitPlainEntry({ ts: new Date().toISOString(), kind: 'batch_completed', fields: { batch_id: batchId, tool, duration_ms: durationMs, task_count: taskCount, ...(dispatchMode !== undefined ? { dispatch_mode: dispatchMode } : {}) } });
          process.stderr.write(
            `[mmagent] event=batch_completed ts=${new Date().toISOString()} batch=${batchId} route=${tool} duration_ms=${durationMs}\n`,
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : undefined;
        const errObj = {
          code: 'runner_crash',
          message,
          ...(stack !== undefined && { stack }),
        };
        batchRegistry.fail(batchId, errObj);
        const durationMs = Date.now() - startedAtMs;
        deps.bus.emitPlainEntry({ ts: new Date().toISOString(), kind: 'batch_failed', fields: { batch_id: batchId, tool, duration_ms: durationMs, error_code: errObj.code, error_message: errObj.message } });
        process.stderr.write(
          `[mmagent] event=batch_failed ts=${new Date().toISOString()} batch=${batchId} route=${tool} duration_ms=${durationMs} error="${message.replace(/"/g, '\\"')}"\n`,
        );
      }
    })();
  });

  return {
    batchId,
    statusUrl: `/batch/${batchId}`,
  };
}

/**
 * Inspect an executor return envelope for structured failure signals.
 * Returns { code, message } when the envelope indicates failure, null
 * otherwise.
 *
 * Per the Gap 5 fix design (wire-telemetry-gaps plan): NO string
 * comparison to "batch succeeded". Use only:
 *   1. Any task result with `structuredError` (most authoritative)
 *   2. Any task result with `status` other than 'ok'
 *   3. Envelope-level `error` object whose `kind` is not 'not_applicable'
 *      (notApplicable() is the structured "no error" sentinel)
 */
function detectFailure(envelope: Record<string, unknown> | undefined): { code: string; message: string } | null {
  if (!envelope) return null;

  const results = Array.isArray(envelope.results) ? envelope.results : [];

  // Source 1: explicit structuredError on any task result
  for (const r of results as Array<Record<string, unknown>>) {
    const se = r.structuredError as { code?: string; message?: string } | null | undefined;
    if (se && typeof se.code === 'string') {
      return { code: se.code, message: typeof se.message === 'string' ? se.message : se.code };
    }
  }

  // Source 2: any task result with status === 'error'.
  // 'incomplete' is intentionally NOT treated as failure — review-rework
  // paths can transit through 'incomplete' on intermediate rounds while
  // the eventual envelope still represents a valid (if imperfect) batch.
  // Only 'error' and 'failed' are categorical batch-level failures.
  for (const r of results as Array<Record<string, unknown>>) {
    const status = r.status;
    if (typeof status === 'string' && (status === 'error' || status === 'failed')) {
      const code = (typeof r.errorCode === 'string' && r.errorCode.length > 0) ? r.errorCode : status;
      const msg = (typeof r.error === 'string' && r.error.length > 0) ? r.error : status;
      return { code, message: msg };
    }
  }

  // Source 3: envelope-level error object with kind != 'not_applicable'
  const env = envelope.error as { kind?: string; code?: string; message?: string } | undefined;
  if (env && typeof env.kind === 'string' && env.kind !== 'not_applicable') {
    return {
      code: typeof env.code === 'string' ? env.code : 'envelope_error',
      message: typeof env.message === 'string' ? env.message : 'envelope error',
    };
  }

  return null;
}
