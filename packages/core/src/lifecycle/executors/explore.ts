import { randomUUID } from 'node:crypto';
import type { ExecutionContext, ExecutorOutput } from './types.js';
import type { Input } from '../../tools/explore/schema.js';
import type { RunResult, MultiModelConfig } from '../../types.js';
import type { ResearchToolDefinition } from '../../research/types.js';
import type { EventEmitter } from '../../events/event-emitter.js';
import { runReviewedTask as executeReviewedLifecycle } from '../run-reviewed-task.js';
import { resolveAgent } from '../../escalation/agent-resolver.js';
import { createProvider } from '../../providers/provider-factory.js';
import { computeTimings, computeAggregateCost } from './shared-compute.js';
import { notApplicable } from '../../reporting/not-applicable.js';
import {
  compileExplore,
  type ResolvedContextBlock,
} from '../../intake/brief-compiler-slots/explore.js';
import {
  parseExploreReport,
  type ParsedExploreReport,
} from '../../reporting/parse-explore-report.js';
import { deriveExploreStatus } from '../../reporting/derive-explore-status.js';
import { composeExploreHeadline } from '../../reporting/compose-explore-headline.js';
import { mapReviewVerdicts } from '../../review/review-verdict-mapping.js';

export interface ExploreExecutorInput {
  input: Input;
  resolvedContextBlocks: ResolvedContextBlock[];
  canonicalizedAnchors: string[];
  relativeAnchorsForPrompt: string[];
  customToolset?: ResearchToolDefinition[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isFailed(result: RunResult): boolean {
  return result.status === 'error' || result.status === 'api_error'
    || result.status === 'provider_transport_failure' || result.status === 'unavailable'
    || result.status === 'api_aborted' || result.status === 'timeout'
    || result.status === 'cost_exceeded' || result.status === 'brief_too_vague'
    || result.status === 'incomplete';
}

function extractReportText(result: RunResult): string {
  return result?.output ?? '';
}

function buildFallbackResult(msg: string): RunResult {
  return {
    output: '',
    status: 'error',
    usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 },
    turns: 0,
    filesRead: [],
    filesWritten: [],
    toolCalls: [],
    outputIsDiagnostic: false,
    escalationLog: [],
    error: msg,
    errorCode: 'executor_error',
    retryable: false,
    durationMs: 0,
    directoriesListed: [],
    structuredReport: {
      summary: null,
      filesChanged: [],
      validationsRun: [],
      deviationsFromBrief: [],
      unresolved: [],
      extraSections: {},
    },
    parsedFindings: [],
    workerStatus: 'failed',
    structuredError: {
      code: 'executor_error' as const,
      message: msg,
      where: 'executor:explore' as const,
    },
  };
}

interface LifecycleCallArgs {
  task: ReturnType<typeof compileExplore>['tasks'][number];
  resolved: ReturnType<typeof resolveAgent>;
  config: MultiModelConfig;
  ctx: ExecutionContext;
  bus?: EventEmitter;
  route: string;
}

async function runLifecycleTask(args: LifecycleCallArgs): Promise<RunResult> {
  const { task, resolved, config, ctx, bus, route } = args;
  return executeReviewedLifecycle(
    task as any,
    resolved,
    config,
    0,
    undefined,
    {
      ...(ctx.batchId !== undefined && { batchId: ctx.batchId }),
      ...(ctx.recordHeartbeat !== undefined && { recordHeartbeat: ctx.recordHeartbeat }),
    },
    { logger: ctx.logger },
    ctx.recorder,
    route,
    ctx.client,
    ctx.triggeringSkill,
    bus,
    undefined,
  );
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export async function executeExplore(
  ctx: ExecutionContext,
  args: ExploreExecutorInput,
): Promise<ExecutorOutput> {
  const { config } = ctx;
  const cwd = ctx.projectContext.cwd;
  const batchId = ctx.batchId ?? randomUUID();

  const research = config.research;
  const hasBrave = (research?.brave?.apiKeys?.length ?? 0) > 0;

  // Resolve agent inside try/catch so resolution failures produce a normal
  // ExecutorOutput envelope instead of throwing.
  let resolved: ReturnType<typeof resolveAgent>;
  try {
    resolved = resolveAgent('complex', config);
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    const fallback = buildFallbackResult(err.message);
    return {
      headline: `explore: agent resolution failed — ${err.message}`,
      results: [fallback],
      batchTimings: computeTimings(0, [fallback]),
      costSummary: computeAggregateCost([fallback]),
      structuredReport: notApplicable('agent resolution failed'),
      error: notApplicable('batch succeeded'),
      batchId,
      wallClockMs: 0,
      mainModel: ctx.mainModel ?? config.defaults?.mainModel,
      specReviewVerdict: 'not_applicable',
      qualityReviewVerdict: 'not_applicable',
      roundsUsed: 0,
    };
  }

  // Use prompt-facing relative anchors when available; fall back to canonicalized.
  const promptAnchors = args.relativeAnchorsForPrompt.length
    ? args.relativeAnchorsForPrompt
    : args.canonicalizedAnchors;

  const compiled = compileExplore(
    args.input,
    args.resolvedContextBlocks,
    promptAnchors,
    cwd,
    {
      userSources: research?.userSources ?? [],
      hasBrave,
      absoluteAnchors: args.canonicalizedAnchors,
    },
  );

  if (compiled.tasks.length !== 3) {
    throw new Error(`compileExplore produced ${compiled.tasks.length} tasks; expected exactly 3`);
  }

  const internalTask = compiled.tasks[0];
  const externalTask = compiled.tasks[1];

  if (internalTask.route !== 'explore_internal' || externalTask.route !== 'explore_external') {
    throw new Error(
      `compileExplore task route mismatch: ${internalTask.route} / ${externalTask.route}`,
    );
  }

  // Create separate provider instances per worker to avoid cross-task
  // contamination when provider implementations carry mutable state.
  let internalProvider: ReturnType<typeof resolveAgent>;
  let externalProvider: ReturnType<typeof resolveAgent>;
  try {
    internalProvider = resolveAgent('complex', config);
    externalProvider = resolveAgent('complex', config);
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    const fallback = buildFallbackResult(err.message);
    return {
      headline: `explore: provider resolution failed — ${err.message}`,
      results: [fallback],
      batchTimings: computeTimings(0, [fallback]),
      costSummary: computeAggregateCost([fallback]),
      structuredReport: notApplicable('provider resolution failed'),
      error: notApplicable('batch succeeded'),
      batchId,
      wallClockMs: 0,
      mainModel: ctx.mainModel ?? config.defaults?.mainModel,
      specReviewVerdict: 'not_applicable',
      qualityReviewVerdict: 'not_applicable',
      roundsUsed: 0,
    };
  }

  if (args.customToolset && args.customToolset.length > 0) {
    externalTask.customToolset = args.customToolset;
  }

  const startMs = Date.now();

  ctx.bus?.emit({
    event: 'explore_parallel_start',
    ts: new Date().toISOString(),
    batchId,
    internalRoute: internalTask.route,
    externalRoute: externalTask.route,
  });

  // --- Parallel fan-out: internal (#0) + external (#1) ---

  const [internalResult, externalResult] = await Promise.all([
    runLifecycleTask({
      task: internalTask,
      resolved: internalProvider,
      config,
      ctx,
      bus: ctx.bus,
      route: internalTask.route,
    }).catch((e: unknown) => {
      const err = e instanceof Error ? e : new Error(String(e));
      return buildFallbackResult(err.message);
    }),
    runLifecycleTask({
      task: externalTask,
      resolved: externalProvider,
      config,
      ctx,
      bus: ctx.bus,
      route: externalTask.route,
    }).catch((e: unknown) => {
      const err = e instanceof Error ? e : new Error(String(e));
      return buildFallbackResult(err.message);
    }),
  ]);

  const internalOk = !isFailed(internalResult);
  const externalOk = !isFailed(externalResult);

  ctx.bus?.emit({
    event: 'explore_parallel_end',
    ts: new Date().toISOString(),
    batchId,
    internalOk,
    externalOk,
    internalDurationMs: internalResult.durationMs ?? 0,
    externalDurationMs: externalResult.durationMs ?? 0,
  });

  // Track degraded sides for the synthesizer prompt and event emission.
  const degraded: ('internal' | 'external')[] = [];
  if (!internalOk) {
    degraded.push('internal');
    ctx.bus?.emit({
      event: 'explore_internal_unavailable',
      ts: new Date().toISOString(),
      batchId,
      reason: internalResult.structuredError?.message ?? 'internal worker failed',
    });
  }
  if (!externalOk) {
    degraded.push('external');
    ctx.bus?.emit({
      event: 'explore_external_unavailable',
      ts: new Date().toISOString(),
      batchId,
      reason: externalResult.structuredError?.message ?? 'external worker failed',
    });
  }

  // --- Synthesizer (#2) ---

  const internalReport = internalOk ? extractReportText(internalResult) : undefined;
  const externalReport = externalOk ? extractReportText(externalResult) : undefined;

  // Re-compile synthesizer prompt with injected reports.
  const synthCompiled = compileExplore(
    args.input,
    args.resolvedContextBlocks,
    promptAnchors,
    cwd,
    {
      userSources: research?.userSources ?? [],
      hasBrave,
      absoluteAnchors: args.canonicalizedAnchors,
      synthesizerDegradedSources: degraded.length ? degraded : undefined,
      internalReport,
      externalReport,
    },
  );

  const synthTask = synthCompiled.tasks[2];

  ctx.bus?.emit({
    event: 'explore_synthesize_start',
    ts: new Date().toISOString(),
    batchId,
    internalAvailable: internalOk,
    externalAvailable: externalOk,
  });

  // Create a fresh provider for the synthesizer.
  let synthProvider: ReturnType<typeof resolveAgent>;
  try {
    synthProvider = resolveAgent('complex', config);
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    const fallback = buildFallbackResult(err.message);
    return {
      headline: `explore: synthesizer provider resolution failed — ${err.message}`,
      results: [internalResult, externalResult, fallback],
      batchTimings: computeTimings(Date.now() - startMs, [internalResult, externalResult, fallback]),
      costSummary: computeAggregateCost([internalResult, externalResult, fallback]),
      structuredReport: notApplicable('provider resolution failed'),
      error: notApplicable('batch succeeded'),
      batchId,
      wallClockMs: Date.now() - startMs,
      mainModel: ctx.mainModel ?? config.defaults?.mainModel,
      specReviewVerdict: 'not_applicable',
      qualityReviewVerdict: 'not_applicable',
      roundsUsed: 0,
    };
  }

  const synthStartMs = Date.now();
  let synthResult: RunResult;
  let synthError: Error | undefined;
  try {
    synthResult = await runLifecycleTask({
      task: synthTask,
      resolved: synthProvider,
      config,
      ctx,
      bus: ctx.bus,
      route: synthTask.route,
    });
  } catch (e) {
    synthError = e instanceof Error ? e : new Error(String(e));
    synthResult = buildFallbackResult(synthError.message);
  }
  const synthDurationMs = Date.now() - synthStartMs;

  // --- Parse synthesizer output ---

  const parseResult = parseExploreReport(synthResult?.output ?? '');
  let parsedReport: ParsedExploreReport | undefined;
  if (parseResult.kind === 'structured_report') {
    parsedReport = parseResult.report;
    if (!synthResult.structuredReport) {
      (synthResult as any).structuredReport = {
        summary: null,
        filesChanged: [],
        validationsRun: [],
        deviationsFromBrief: [],
        unresolved: [],
        extraSections: {},
      };
    }
    (synthResult.structuredReport as any).explore = parsedReport;
  }

  const threadCount = parsedReport?.threads.length ?? 0;

  // Emit per-thread started/completed events
  if (parsedReport) {
    for (const thread of parsedReport.threads) {
      ctx.bus?.emit({
        event: 'explore_thread_started',
        ts: new Date().toISOString(),
        batchId,
        threadIndex: thread.index,
      });
      ctx.bus?.emit({
        event: 'explore_thread_completed',
        ts: new Date().toISOString(),
        batchId,
        threadIndex: thread.index,
      });
    }
  }

  ctx.bus?.emit({
    event: 'explore_synthesize_end',
    ts: new Date().toISOString(),
    batchId,
    threadCount,
    recommendedNextStep: parsedReport
      ? parsedReport.recommendedNextStep !== null && parsedReport.recommendedNextStep !== undefined
      : false,
    durationMs: synthDurationMs,
  });

  // --- Derive status ---

  const synthFailed = isFailed(synthResult) || synthError !== undefined;
  const capExhausted = (synthResult as any)?.capExhausted as 'turn' | 'cost' | 'wall_clock' | undefined;
  const workerError = synthError ?? ((synthResult as any)?.workerError as Error | undefined);

  const derived = deriveExploreStatus({
    workerError,
    capExhausted,
    parseDiagnostics: parsedReport?.diagnostics ?? {
      malformed: false,
      insufficientThreads: false,
      droppedThreads: [],
    },
    threads: threadCount,
  });

  // Override synthesizer workerStatus authoritatively.
  (synthResult as any).workerStatus = derived.workerStatus;
  if (derived.incompleteReason !== undefined) {
    (synthResult as any).incompleteReason = derived.incompleteReason;
  }

  // --- Compute failedCount for headline ---

  let failedCount = 0;
  if (!internalOk) failedCount++;
  if (!externalOk) failedCount++;

  const allResults = [internalResult, externalResult, synthResult];

  const headline = composeExploreHeadline({
    taskCount: 3,
    failedCount,
    threadCount,
    synthFailed,
  });

  // --- Review verdicts ---

  // explore tasks have reviewPolicy: 'none' — reviews are always skipped.
  const reviewVerdicts = mapReviewVerdicts(synthResult, true);

  // --- Aggregate ---

  const wallClockMs = Date.now() - startMs;

  return {
    headline,
    results: allResults,
    batchTimings: computeTimings(wallClockMs, allResults),
    costSummary: computeAggregateCost(allResults),
    structuredReport: notApplicable('per-task structured report carried on result'),
    error: notApplicable('batch succeeded'),
    batchId,
    wallClockMs,
    mainModel: ctx.mainModel ?? config.defaults?.mainModel,
    specReviewVerdict: reviewVerdicts.specReviewVerdict,
    qualityReviewVerdict: reviewVerdicts.qualityReviewVerdict,
    roundsUsed: reviewVerdicts.roundsUsed,
  };
}
