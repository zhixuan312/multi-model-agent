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

  // ── Step 3: Build TaskSpecs from briefs ──
  const tasks: TaskSpec[] = briefs.map((brief) =>
    config.buildTaskSpec(brief, ctx),
  );

  // Store TaskSpecs in the per-project batch cache so retry can
  // reconstruct original tasks without re-invoking the brief slot.
  if (ctx.batchId && ctx.projectContext?.batchCache) {
    ctx.projectContext.batchCache.remember(ctx.batchId, tasks);
  }

  // ── Step 4: Dispatch ──
  const mainModel = ctx.mainModel ?? ctx.config.defaults?.mainModel ?? undefined;
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
        triggeringSkill: ctx.triggeringSkill,
        bus: ctx.bus,
        reviewerEngine: ctx.reviewerEngine ?? createDefaultReviewerEngine(),
        annotatorEngine: ctx.annotatorEngine ?? createDefaultAnnotatorEngine(),
      });
      results = [result];
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
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
          durationMs: 0,
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
          triggeringSkill: ctx.triggeringSkill,
          bus: ctx.bus,
          reviewerEngine: ctx.reviewerEngine ?? createDefaultReviewerEngine(),
          annotatorEngine: ctx.annotatorEngine ?? createDefaultAnnotatorEngine(),
        }).catch((e: unknown): RunResult => {
          const msg = e instanceof Error ? e.message : String(e);
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
            durationMs: 0,
            structuredError: { code: 'runner_crash' as const, message: msg, where: `executor:${config.name}` },
            workerStatus: 'failed' as const,
          };
        }),
      ),
    );
  }
  const wallClockMs = Date.now() - startMs;

  // ── Step 5: Auto-register context block ──
  const contextBlockId = autoRegisterContextBlock(results, ctx.contextBlockStore);

  // ── Step 6: Compute timings + cost ──
  const batchTimings = computeTimings(wallClockMs, results);
  const costSummary = computeAggregateCost(results);

  // ── Step 7: Parse structured report ──
  let structuredReport: Record<string, unknown> | NotApplicable;
  const primaryOutput = results[0]?.output;
  if (primaryOutput && primaryOutput.trim().length > 0) {
    try {
      structuredReport = config.reportSchema.parse(primaryOutput) as Record<string, unknown>;
    } catch {
      structuredReport = notApplicable(`reportSchema.parse failed for ${config.name}`);
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
    costSummary: { totalActualCostUSD: 0, totalCostDeltaVsParentUSD: 0 },
    structuredReport: notApplicable('no briefs produced'),
    error: notApplicable('batch succeeded'),
    batchId: ctx.batchId ?? randomUUID(),
    wallClockMs: 0,
    mainModel: ctx.mainModel ?? ctx.config.defaults?.mainModel,
    specReviewVerdict: 'not_applicable',
    qualityReviewVerdict: 'not_applicable',
    roundsUsed: 0,
  };
}
