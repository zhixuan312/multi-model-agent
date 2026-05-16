import { randomUUID } from 'node:crypto';
import type { ToolConfig } from './tool-config-types.js';
import type { ExecutionContext } from './lifecycle-context.js';
import type { ExecutorOutput } from './executor-output-types.js';
import type { TaskSpec, RuntimeRunResult } from '../types.js';
import { resolveAgent } from '../escalation/agent-resolver.js';
import { runTaskViaDispatcher } from './task-runner.js';
import { computeTimings, computeAggregateCost } from './shared-compute.js';
import { autoRegisterContextBlock } from './auto-register-context-block.js';
import { mapReviewVerdicts } from '../review/review-verdict-mapping.js';
import { notApplicable, type NotApplicable } from '../reporting/not-applicable.js';
import { parseStructuredReport } from '../reporting/structured-report.js';
import { expandContextBlocks } from '../stores/expand-context-blocks.js';
import { groupTasksByRepo, type TaskGroup } from './task-grouping.js';
import { buildCancelledResult } from './build-cancelled-result.js';
import { getDirtyFiles, formatHygieneAdvisory } from './repo-hygiene.js';

/**
 * Inner loop for grouped dispatch. Runs each group in parallel; within
 * each group runs tasks sequentially in caller input order. Aborted
 * not-yet-started tasks receive a cancelled-result envelope.
 * Failures within a group are caught by dispatchOne (RuntimeRunResult
 * with workerStatus='failed') and DO NOT halt subsequent group members.
 *
 * Returns results indexed by original task order.
 */
export async function dispatchGroupedWithPrecomputedGroups(
  tasks: TaskSpec[],
  groups: TaskGroup[],
  dispatchOne: (task: TaskSpec, originalIndex: number) => Promise<RuntimeRunResult>,
  opts: { abortSignal?: AbortSignal },
): Promise<RuntimeRunResult[]> {
  const results: RuntimeRunResult[] = new Array(tasks.length);
  await Promise.all(
    groups.map(async (group) => {
      const isGitRepo = !group.key.startsWith('/') || true; // group.key is always either a toplevel or realpath
      let isFirstInGroup = true;
      for (const { task, originalIndex } of group.tasks) {
        if (opts.abortSignal?.aborted) {
          results[originalIndex] = buildCancelledResult();
          continue;
        }
        let effectiveTask = task;
        if (!isFirstInGroup && group.tasks.length > 1) {
          const dirty = await getDirtyFiles(group.key);
          if (dirty.length > 0) {
            const advisory = formatHygieneAdvisory(dirty);
            effectiveTask = { ...task, prompt: advisory + task.prompt };
          }
        }
        results[originalIndex] = await dispatchOne(effectiveTask, originalIndex);
        isFirstInGroup = false;
      }
    }),
  );
  return results;
}

/**
 * Convenience wrapper that resolves the grouping internally. Used by
 * tests; production callers use the precomputed-groups variant so they
 * can also set ctx.batchGroupCount and call ctx.attachBatchGroups before
 * dispatch begins.
 */
export async function dispatchGrouped(
  tasks: TaskSpec[],
  dispatchOne: (task: TaskSpec, originalIndex: number) => Promise<RuntimeRunResult>,
  opts: { abortSignal?: AbortSignal },
): Promise<RuntimeRunResult[]> {
  const groups = await groupTasksByRepo(tasks);
  return dispatchGroupedWithPrecomputedGroups(tasks, groups, dispatchOne, opts);
}

/**
 * Generic per-task orchestrator. Takes a ToolConfig (which encodes all
 * tool-specific behavior: brief compilation, TaskSpec building, headline
 * composition, report parsing), an ExecutionContext, and raw tool input,
 * and runs the standard pipeline:
 *
 *   1. Compile briefs via config.briefSlot(input)
 *   2. Resolve agent via resolveAgent(config.agentType, config)
 *   3. Build TaskSpec per brief via config.buildTaskSpec
 *   4. Dispatch each task via runTaskViaDispatcher
 *   5. Auto-register context block from usable outputs
 *   6. Compute batch timings + aggregate cost
 *   7. Parse structured report via config.reportSchema
 *   8. Compose headline via config.headlineTemplate
 *   9. Map review verdicts
 *  10. Return ExecutorOutput
 *
 * Target: ≤ 200 LOC. If it grows past 250, factor helpers back out.
 */
export async function executeTask<Input, Brief, Report>(
  config: ToolConfig<Input, Brief, Report>,
  ctx: ExecutionContext,
  input: Input,
): Promise<ExecutorOutput> {
  // ── Step 1: Compile briefs ──
  const briefs = config.briefSlot(input);
  if (!Array.isArray(briefs) || briefs.length === 0) {
    // No tasks to run — return an empty-ok envelope.
    return emptyEnvelope(config.name, ctx);
  }

  // ── Step 2: Build TaskSpecs from briefs, then expand contextBlockIds ──
  // Gap 1 cache-invariant fix (4.0.3+): batch cache MUST store the EXPANDED,
  // contextBlockIds-stripped task. If we cache the original (with
  // contextBlockIds) and the contextBlockStore loses entries before retry,
  // retry resolves stale IDs and fails. expandContextBlocks strips
  // contextBlockIds from the returned task, so subsequent expansion calls
  // are a no-op (idempotent).
  const tasks: TaskSpec[] = briefs.map((brief) => {
    const built = config.buildTaskSpec(brief, ctx);
    return ctx.contextBlockStore
      ? expandContextBlocks(built, ctx.contextBlockStore)
      : built;
  });

  // ── Step 3: Resolve agent per task ──
  // Each task's agentType (set by the brief slot) selects its provider.
  // For tools where agentTypeOverridable=false, every brief carries the
  // tool default and this collapses to one resolution per agent slot;
  // for tools where it's true (delegate, retry), this honors per-task
  // overrides instead of forcing the whole batch onto one tier.
  const resolvedPerTask = tasks.map((task) => {
    try {
      return resolveAgent(task.agentType ?? config.agentType, ctx.config);
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : String(err),
      } as const;
    }
  });

  // Store TaskSpecs in the per-project batch cache so retry can
  // reconstruct original tasks without re-invoking the brief slot.
  // (Tasks here are already expanded — see comment above.)
  if (ctx.batchId && ctx.projectContext?.batchCache) {
    ctx.projectContext.batchCache.remember(ctx.batchId, tasks);
  }

  // ── Step 4: Dispatch ──
  const mainModel = ctx.mainModel;
  const startMs = Date.now();

  const buildCrashResult = (msg: string): RuntimeRunResult => ({
    output: '',
    status: 'error' as const,
    usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 },
    turns: 0,
    filesRead: [],
    filesWritten: [],
    toolCalls: [],
    outputIsDiagnostic: false,
    escalationLog: [],
    error: msg,
    errorCode: 'runner_crash',
    retryable: false,
    durationMs: Date.now() - startMs,
    structuredError: { code: 'runner_crash' as const, message: msg, where: `executor:${config.name}` },
    workerStatus: 'failed' as const,
    actualCostUSD: 0,
    directoriesListed: [],
  });

  const buildAgentNotConfiguredResult = (msg: string): RuntimeRunResult => ({
    output: '',
    status: 'error' as const,
    usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 },
    turns: 0,
    filesRead: [],
    filesWritten: [],
    toolCalls: [],
    outputIsDiagnostic: false,
    escalationLog: [],
    error: msg,
    errorCode: 'agent_not_configured',
    retryable: false,
    durationMs: Date.now() - startMs,
    workerStatus: 'failed' as const,
    actualCostUSD: 0,
    directoriesListed: [],
  });

  const dispatchOne = async (task: TaskSpec, i: number): Promise<RuntimeRunResult> => {
    const r = resolvedPerTask[i]!;
    if ('error' in r) {
      return buildAgentNotConfiguredResult(r.error);
    }
    try {
      return await runTaskViaDispatcher({
        task,
        resolved: r,
        config: ctx.config,
        taskIndex: i,
        batchId: ctx.batchId,
        recordHeartbeat: ctx.recordHeartbeat,
        logger: ctx.logger,
        verbose: ctx.verbose,
        verboseStream: ctx.verboseStream,
        recorder: ctx.recorder,
        route: ctx.route ?? config.name,
        client: ctx.client,
        mainModel: ctx.mainModel,
        bus: ctx.bus,
        ...(ctx.contextBlockStore && { contextBlockStore: ctx.contextBlockStore }),
        ...((ctx as any).reviewerEngine !== undefined && { reviewerEngine: (ctx as any).reviewerEngine }),
      });
    } catch (e) {
      // Gap 3 fix (round-2 F5): durationMs MUST be set on EVERY return,
      // including failure envelopes. Pre-fix, error envelopes carried
      // durationMs:0 — failed runs were invisible in cost-per-time
      // analysis, retry budgeting, and operator debugging.
      return buildCrashResult(e instanceof Error ? e.message : String(e));
    }
  };

  let results: RuntimeRunResult[];
  if (config.serializeSameRepo && tasks.length > 1) {
    // Compute groups once so we can both:
    //   - set ctx.batchGroupCount BEFORE dispatch (task-runner reads this
    //     to gate PARALLEL_SAFETY_SUFFIX), and
    //   - call ctx.attachBatchGroups so the 202 headline composer can
    //     describe active groups.
    const groups = await groupTasksByRepo(tasks);
    (ctx as { batchGroupCount?: number }).batchGroupCount = groups.length;
    ctx.attachBatchGroups?.(
      groups.map((g) => ({
        key: g.key,
        taskIndices: g.tasks.map((t) => t.originalIndex),
      })),
    );
    ctx.setBatchGroupingTelemetry?.({
      groupCount: groups.length,
      groupSizes: groups.map((g) => g.tasks.length),
      serializationApplied: groups.some((g) => g.tasks.length > 1),
    });
    results = await dispatchGroupedWithPrecomputedGroups(
      tasks,
      groups,
      (task, i) => dispatchOne(task, i),
      { abortSignal: ctx.stall.controller.signal },
    );
  } else if (tasks.length === 1) {
    results = [await dispatchOne(tasks[0]!, 0)];
  } else {
    results = await Promise.all(tasks.map((task, i) => dispatchOne(task, i)));
  }
  const wallClockMs = Date.now() - startMs;

  // Gap 3 fix (4.0.3+): surface the executor's wall-clock as
  // result.durationMs on each task. The dispatcher's runResult.durationMs
  // only covers the implementer's shell.run wall-clock, missing
  // reviewer/annotator stages. Setting it here means retry callers + the
  // wire builder's Math.max see the real total. Skip if the result already
  // has a larger durationMs (e.g., dispatcher tracked something we didn't).
  for (const r of results) {
    if (!r.durationMs || r.durationMs < wallClockMs) {
      (r as { durationMs: number }).durationMs = wallClockMs;
    }
  }

  // ── Step 5: Auto-register context block ──
  const contextBlockId = autoRegisterContextBlock(results, ctx.contextBlockStore);

  // ── Step 6: Compute timings + cost ──
  const batchTimings = computeTimings(wallClockMs, results);
  const costSummary = computeAggregateCost(results);

  // ── Step 7: Resolve structured report ──
  // v4.4.x: the Annotating handler builds the canonical unified StructuredReport
  // and compose_response attaches it onto results[N].structuredReport. Prefer
  // that. Fall back to legacy per-tool schema / narrative parser only when the
  // annotator did not run (terminal short-circuit, register-block route).
  let structuredReport: Record<string, unknown> | NotApplicable;
  const annotatorReport = results[0] && (results[0] as { structuredReport?: unknown }).structuredReport;
  if (annotatorReport && typeof annotatorReport === 'object') {
    structuredReport = annotatorReport as Record<string, unknown>;
  } else {
    const primaryOutput = results[0]?.output;
    if (primaryOutput && primaryOutput.trim().length > 0) {
      try {
        structuredReport = config.reportSchema.parse(primaryOutput) as Record<string, unknown>;
      } catch {
        structuredReport = parseStructuredReport(primaryOutput) as unknown as Record<string, unknown>;
      }
    } else {
      structuredReport = notApplicable('no task output to parse');
    }
  }

  // ── Step 8: Compose headline ──
  // v4.5.2+: pass runResult + task so audit/review/debug composers can
  // fall back to parseNarrativeFindings(runResult.output) and read
  // task.filePaths for the document path when the structured report
  // doesn't carry them.
  const headline = config.headlineTemplate.compose({
    taskBrief: typeof briefs[0] === 'object' && briefs[0] !== null
      ? ((briefs[0] as Record<string, unknown>).prompt as string)
        ?? ((briefs[0] as Record<string, unknown>).brief as string)
        ?? (briefs[0] as Record<string, unknown>).question as string
        ?? config.name
      : config.name,
    report: structuredReport,
    status: results[0]?.status ?? 'error',
    ...(results[0] && { runResult: results[0] }),
    ...(tasks[0] && { task: tasks[0] }),
  });

  // ── Step 9: Map review verdicts ──
  const verdicts = mapReviewVerdicts(results[0] ?? {}, false);

  // ── Step 10: Build + post-process envelope ──
  let envelope: ExecutorOutput = {
    headline,
    results,
    batchTimings,
    costSummary,
    structuredReport: structuredReport as ExecutorOutput['structuredReport'],
    error: notApplicable('batch succeeded'),
    batchId: ctx.batchId ?? randomUUID(),
    wallClockMs,
    mainModel,
    specReviewVerdict: verdicts.specReviewVerdict,
    qualityReviewVerdict: verdicts.qualityReviewVerdict,
    roundsUsed: verdicts.roundsUsed,
    ...(contextBlockId !== undefined && { contextBlockId }),
  };

  if (config.postProcessEnvelope) {
    envelope = await config.postProcessEnvelope(envelope, ctx);
  }

  return envelope;
}

/** Return an empty-ok envelope when briefSlot produces no briefs. */
function emptyEnvelope(toolName: string, ctx: ExecutionContext): ExecutorOutput {
  return {
    headline: `${toolName}: no tasks executed`,
    results: [],
    batchTimings: { wallClockMs: 0, sumOfTaskMs: 0, estimatedParallelSavingsMs: 0 },
    costSummary: { totalActualCostUSD: 0, totalCostDeltaVsMainUSD: 0 },
    structuredReport: notApplicable('no briefs produced'),
    error: notApplicable('batch succeeded'),
    batchId: ctx.batchId ?? randomUUID(),
    wallClockMs: 0,
    mainModel: ctx.mainModel,
    specReviewVerdict: 'not_applicable',
    qualityReviewVerdict: 'not_applicable',
    roundsUsed: 0,
  };
}
