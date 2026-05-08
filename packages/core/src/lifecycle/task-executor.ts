import { randomUUID } from 'node:crypto';
import type { ToolConfig } from './tool-config-types.js';
import type { ExecutionContext } from './lifecycle-context.js';
import type { ExecutorOutput } from './executor-output-types.js';
import type { TaskSpec, RunResult } from '../types.js';
import { resolveAgent } from '../escalation/agent-resolver.js';
import { runTaskViaDispatcher } from './task-runner.js';
import { computeTimings, computeAggregateCost } from './shared-compute.js';
import { autoRegisterContextBlock } from './auto-register-context-block.js';
import { mapReviewVerdicts } from '../review/review-verdict-mapping.js';
import { notApplicable, type NotApplicable } from '../reporting/not-applicable.js';
import { createDefaultReviewerEngine, createDefaultAnnotatorEngine } from '../review/default-engines.js';
import { parseStructuredReport } from '../reporting/structured-report.js';
import { expandContextBlocks } from '../stores/expand-context-blocks.js';

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

  // ── Step 2: Resolve agent ──
  const resolved = resolveAgent(config.agentType, ctx.config);

  // ── Step 3: Build TaskSpecs from briefs, then expand contextBlockIds ──
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

  // Store TaskSpecs in the per-project batch cache so retry can
  // reconstruct original tasks without re-invoking the brief slot.
  // (Tasks here are already expanded — see comment above.)
  if (ctx.batchId && ctx.projectContext?.batchCache) {
    ctx.projectContext.batchCache.remember(ctx.batchId, tasks);
  }

  // ── Step 4: Dispatch ──
  const mainModel = ctx.mainModel;
  const startMs = Date.now();

  let results: RunResult[];
  if (tasks.length === 1) {
    // Single task: dispatch directly.
    try {
      const result = await runTaskViaDispatcher({
        task: tasks[0]!,
        resolved,
        config: ctx.config,
        taskIndex: 0,
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
        reviewerEngine: ctx.reviewerEngine ?? createDefaultReviewerEngine(),
        annotatorEngine: ctx.annotatorEngine ?? createDefaultAnnotatorEngine(),
      });
      results = [result];
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Gap 3 fix (round-2 F5): durationMs MUST be set on EVERY return,
      // including failure envelopes. Pre-fix, error envelopes carried
      // durationMs:0 — failed runs were invisible in cost-per-time
      // analysis, retry budgeting, and operator debugging.
      results = [
        {
          output: '',
          status: 'error' as const,
          usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 },
          turns: 0,
          filesRead: [],
          filesWritten: [],
          toolCalls: [],
          outputIsDiagnostic: false,
          escalationLog: [],
          parsedFindings: null,
          error: msg,
          errorCode: 'runner_crash',
          retryable: false,
          durationMs: Date.now() - startMs,
          structuredError: { code: 'runner_crash' as const, message: msg, where: `executor:${config.name}` },
          workerStatus: 'failed' as const,
        },
      ];
    }
  } else {
    // Fan-out: dispatch all tasks in parallel.
    results = await Promise.all(
      tasks.map((task, i) =>
        runTaskViaDispatcher({
          task,
          resolved,
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
          reviewerEngine: ctx.reviewerEngine ?? createDefaultReviewerEngine(),
          annotatorEngine: ctx.annotatorEngine ?? createDefaultAnnotatorEngine(),
        }).catch((e: unknown): RunResult => {
          const msg = e instanceof Error ? e.message : String(e);
          // Gap 3 fix (round-2 F5): set durationMs on failure envelopes
          // so cost-per-time + retry budgeting see real wall-clock.
          return {
            output: '',
            status: 'error' as const,
            usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 },
            turns: 0,
            filesRead: [],
            filesWritten: [],
            toolCalls: [],
            outputIsDiagnostic: false,
            escalationLog: [],
            parsedFindings: null,
            error: msg,
            errorCode: 'runner_crash',
            retryable: false,
            durationMs: Date.now() - startMs,
            structuredError: { code: 'runner_crash' as const, message: msg, where: `executor:${config.name}` },
            workerStatus: 'failed' as const,
          };
        }),
      ),
    );
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

  // ── Step 7: Parse structured report ──
  // First try the per-tool schema. Five of the ten tools (audit, review,
  // verify, debug, investigate) instruct workers to emit narrative
  // `## Finding N: ...` rather than JSON; for those, the per-tool schema
  // always throws. Fall back to the generic narrative parser so the
  // envelope's structuredReport carries the parsed sections instead of a
  // "parse failed" sentinel. The narrative parser never throws — empty
  // input yields an empty ParsedStructuredReport.
  let structuredReport: Record<string, unknown> | NotApplicable;
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

  // ── Step 8: Compose headline ──
  const headline = config.headlineTemplate.compose({
    taskBrief: typeof briefs[0] === 'object' && briefs[0] !== null
      ? ((briefs[0] as Record<string, unknown>).prompt as string)
        ?? ((briefs[0] as Record<string, unknown>).brief as string)
        ?? (briefs[0] as Record<string, unknown>).question as string
        ?? config.name
      : config.name,
    report: structuredReport,
    status: results[0]?.status ?? 'error',
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
