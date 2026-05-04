import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  Provider,
  RunResult,
  TaskSpec,
  MultiModelConfig,
  AgentType,
  Commit,
  FallbackOverride,
  StageStatsMap,
  ReviewVerdict,
  VerifyOutcome,
  VerifySkipReason,
} from '../types.js';
import type { RunStatus, InternalRunnerEvent } from '../runners/types.js';
import { createProvider } from '../provider.js';
import { delegateWithEscalation } from '../delegate-with-escalation.js';
import {
  pickEscalation,
  pickReviewer,
  maxRowsFor,
  maxReworksFor,
} from '../escalation/policy.js';
import {
  runWithFallback,
  makeSyntheticRunResult,
  markUnavailable,
  TRANSPORT_FAILURES,
  isReviewTransportFailure,
  type UnavailableMap,
  type FallbackReason,
} from '../escalation/fallback.js';
import { findModelCapabilities, findModelProfile } from '../routing/model-profiles.js';
import { canonicalIdentity } from '../routing/canonical-model-identity.js';
import { HeartbeatTimer } from '../heartbeat.js';
import { newStageIdleTracker, snapshotIdle, type StageIdleTracker } from './stage-idle-tracker.js';
import { priceTokens, subtractTokens, resolveRateCard } from '../cost/compute.js';
import type { TokenUsage } from '../runners/types.js';
import { DEFAULT_TASK_TIMEOUT_MS, DEFAULT_STALL_TIMEOUT_MS, MAX_TIME_PRESTOP_RATIO } from '../config/schema.js';
import { runSpecReview } from '../review/spec-reviewer.js';
import { makeSkippedReviewResult } from '../review/skipped-result.js';
import { runQualityReview } from '../review/quality-reviewer.js';
import type { LegacyQualityReviewResult } from '../review/quality-reviewer.js';
import { runDiffReview, type DiffReviewOrSkipped } from '../review/diff-review.js';
import { aggregateResult } from '../review/aggregate-result.js';
import { buildEvidence } from '../review/evidence.js';
import { parseStructuredReport } from '../reporting/structured-report.js';
import type { CommitFields } from '../reporting/structured-report.js';
import { runCommitStage, readbackCommit } from './commit-stage.js';
import { runVerifyStage, type VerifyStageResult } from './verify-stage.js';
import { runMetadataRepairTurn } from './metadata-repair.js';
import { partitionFilePaths, checkOutputTargets } from '../file-artifact-check.js';
import type { RunTasksProgressCallback } from './index.js';
import { extractWorkerStatus } from './worker-status.js';
import { buildFallbackImplReport, readImplementerFileContents } from './fallback-report.js';
import { composeVerboseLine, toVerboseFields } from '../diagnostics/verbose-line.js';
import { computeTaskCompletionSummary, formatTaskDoneLine } from './task-completion-summary.js';
import type {
  FallbackEventParams,
  FallbackUnavailableEventParams,
  EscalationEventParams,
  EscalationUnavailableEventParams,
} from '../diagnostics/types.js';
import { withDoneCondition } from './execute-task.js';

const exec = promisify(execFile);

const READ_ONLY_TOOL_NAMES: Set<string> = new Set([
  'audit', 'review', 'verify', 'investigate', 'debug',
]);

const _emptyMetrics = { inputTokens: null, outputTokens: null, cachedTokens: null, reasoningTokens: null, turnCount: null, toolCallCount: null, filesReadCount: null, filesWrittenCount: null } as const;

export function emptyStats(): StageStatsMap {
  return {
    implementing:   { stage: 'implementing',   entered: false, durationMs: null, costUSD: null, agentTier: null, modelFamily: null, model: null, maxIdleMs: 0, totalIdleMs: 0, activityEvents: 0, ..._emptyMetrics },
    spec_rework:    { stage: 'spec_rework',    entered: false, durationMs: null, costUSD: null, agentTier: null, modelFamily: null, model: null, maxIdleMs: 0, totalIdleMs: 0, activityEvents: 0, ..._emptyMetrics },
    quality_rework: { stage: 'quality_rework', entered: false, durationMs: null, costUSD: null, agentTier: null, modelFamily: null, model: null, maxIdleMs: 0, totalIdleMs: 0, activityEvents: 0, ..._emptyMetrics },
    committing:     { stage: 'committing',     entered: false, durationMs: null, costUSD: null, agentTier: null, modelFamily: null, model: null, maxIdleMs: 0, totalIdleMs: 0, activityEvents: 0, ..._emptyMetrics },
    verifying:      { stage: 'verifying',      entered: false, durationMs: null, costUSD: null, agentTier: null, modelFamily: null, model: null, maxIdleMs: 0, totalIdleMs: 0, activityEvents: 0, outcome: null, skipReason: null, ..._emptyMetrics },
    spec_review:    { stage: 'spec_review',    entered: false, durationMs: null, costUSD: null, agentTier: null, modelFamily: null, model: null, maxIdleMs: 0, totalIdleMs: 0, activityEvents: 0, verdict: null, roundsUsed: null, ..._emptyMetrics },
    quality_review: { stage: 'quality_review', entered: false, durationMs: null, costUSD: null, agentTier: null, modelFamily: null, model: null, maxIdleMs: 0, totalIdleMs: 0, activityEvents: 0, verdict: null, roundsUsed: null, ..._emptyMetrics },
    diff_review:    { stage: 'diff_review',    entered: false, durationMs: null, costUSD: null, agentTier: null, modelFamily: null, model: null, maxIdleMs: 0, totalIdleMs: 0, activityEvents: 0, verdict: null, roundsUsed: null, ..._emptyMetrics },
  };
}

function modelFamily(model: string): string {
  return findModelProfile(model).family;
}

export function endBaseStage(
  stats: StageStatsMap,
  name: 'implementing' | 'spec_rework' | 'quality_rework' | 'committing',
  t0: number,
  c0: number | null,
  agent: { tier: 'standard' | 'complex'; model: string },
  finalCostUSD: number | null,
  idle: { maxIdleMs: number; totalIdleMs: number; activityEvents: number } | null,
  metrics?: { inputTokens?: number; outputTokens?: number; cachedTokens?: number; reasoningTokens?: number; turnCount?: number; toolCallCount?: number; filesReadCount?: number; filesWrittenCount?: number; costUSD?: number },
): void {
  // Cast through unknown — TS can't narrow stats[name] on a union-typed index;
  // the runtime invariant (set name's slot to its matching variant) is enforced
  // by the helper signature and tested by tests/run-tasks/stage-stats.test.ts.
  (stats as Record<string, unknown>)[name] = {
    stage: name,
    entered: true,
    durationMs: Date.now() - t0,
    costUSD: metrics?.costUSD !== undefined ? metrics.costUSD
      : finalCostUSD !== null && c0 !== null ? finalCostUSD - c0 : null,
    agentTier: agent.tier,
    modelFamily: modelFamily(agent.model),
    model: agent.model,
    maxIdleMs: idle?.maxIdleMs ?? 0,
    totalIdleMs: idle?.totalIdleMs ?? 0,
    activityEvents: idle?.activityEvents ?? 0,
    inputTokens: metrics?.inputTokens ?? null,
    outputTokens: metrics?.outputTokens ?? null,
    cachedTokens: metrics?.cachedTokens ?? null,
    reasoningTokens: metrics?.reasoningTokens ?? null,
    turnCount: metrics?.turnCount ?? null,
    toolCallCount: metrics?.toolCallCount ?? null,
    filesReadCount: metrics?.filesReadCount ?? null,
    filesWrittenCount: metrics?.filesWrittenCount ?? null,
  };
}

export function endReviewStage(
  stats: StageStatsMap,
  name: 'spec_review' | 'quality_review' | 'diff_review',
  t0: number,
  c0: number | null,
  agent: { tier: 'standard' | 'complex'; model: string },
  finalCostUSD: number | null,
  idle: { maxIdleMs: number; totalIdleMs: number; activityEvents: number } | null,
  verdict: ReviewVerdict,
  roundsUsed: number,
  // metrics.durationMs OVERRIDES the t0-based fallback. Use this when the
  // stage runs in multiple discrete invocations (initial + rework re-reviews
  // for spec_review and quality_review) — the caller accumulates per-call
  // wall time and passes the sum, instead of `Date.now() - t0` which would
  // span the entire review block including subsequent stages.
  metrics?: { inputTokens?: number; outputTokens?: number; cachedTokens?: number; reasoningTokens?: number; turnCount?: number; toolCallCount?: number; filesReadCount?: number; filesWrittenCount?: number; costUSD?: number; durationMs?: number },
): void {
  const durationMs = metrics?.durationMs !== undefined ? metrics.durationMs : Date.now() - t0;
  // Idle-tracker leak guard: stageIdle is reset at every transitionStage(),
  // but runAnnotationReview makes 2 sequential delegateWithEscalation calls
  // (attempt1 + attempt2), and tail events from cross-runner async cleanup
  // can land after the stage's wall-clock end, producing totalIdleMs values
  // that exceed durationMs (3.12.2 saw 110-145% idle ratios). Clamping here
  // prevents impossible values from reaching the dashboard while preserving
  // the legitimate per-stage signal in the common case.
  const rawTotalIdle = idle?.totalIdleMs ?? 0;
  const rawMaxIdle = idle?.maxIdleMs ?? 0;
  const clampedTotalIdle = Math.min(rawTotalIdle, Math.max(0, durationMs));
  const clampedMaxIdle = Math.min(rawMaxIdle, Math.max(0, durationMs));
  (stats as Record<string, unknown>)[name] = {
    stage: name,
    entered: true,
    durationMs,
    // Item 7: != null (covers both undefined AND null) — null means
    // "pricing unavailable, fall through to runningCostUSD computation"
    // rather than masking unknown as the literal 0.
    costUSD: metrics?.costUSD != null ? metrics.costUSD
      : finalCostUSD !== null && c0 !== null ? finalCostUSD - c0 : null,
    agentTier: agent.tier,
    modelFamily: modelFamily(agent.model),
    model: agent.model,
    maxIdleMs: clampedMaxIdle,
    totalIdleMs: clampedTotalIdle,
    activityEvents: idle?.activityEvents ?? 0,
    inputTokens: metrics?.inputTokens ?? null,
    outputTokens: metrics?.outputTokens ?? null,
    cachedTokens: metrics?.cachedTokens ?? null,
    reasoningTokens: metrics?.reasoningTokens ?? null,
    turnCount: metrics?.turnCount ?? null,
    toolCallCount: metrics?.toolCallCount ?? null,
    filesReadCount: metrics?.filesReadCount ?? null,
    filesWrittenCount: metrics?.filesWrittenCount ?? null,
    verdict,
    roundsUsed,
  };
}

// Per-iteration aggregator for spec_rework / quality_rework. Each rework loop
// can run multiple iterations; the stage map only has one slot per stage, so
// we sum metrics across iterations and overwrite the slot after each one.
// Writing per-iteration (rather than once after the loop) means abort paths
// (round_cap, cost_ceiling) still preserve completed-iteration data.
export interface ReworkAccumulator {
  occurred: boolean;
  durationMs: number;
  costUSD: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  turnCount: number;
  toolCallCount: number;
  filesReadCount: number;
  filesWrittenCount: number;
  maxIdleMs: number;
  totalIdleMs: number;
  activityEvents: number;
}

export function emptyReworkAcc(): ReworkAccumulator {
  return {
    occurred: false,
    durationMs: 0, costUSD: 0,
    inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0,
    turnCount: 0, toolCallCount: 0, filesReadCount: 0, filesWrittenCount: 0,
    maxIdleMs: 0, totalIdleMs: 0, activityEvents: 0,
  };
}

export function accumulateReworkIteration(
  acc: ReworkAccumulator,
  result: { usage?: { inputTokens?: number | null; outputTokens?: number | null; costUSD?: number | null; cachedTokens?: number | null; reasoningTokens?: number | null } | null; turns?: number; toolCalls?: unknown[]; filesRead?: unknown[]; filesWritten?: unknown[] },
  iterDurationMs: number,
  idle: { maxIdleMs: number; totalIdleMs: number; activityEvents: number } | null,
): void {
  acc.occurred = true;
  acc.durationMs += iterDurationMs;
  acc.costUSD += result.usage?.costUSD ?? 0;
  acc.inputTokens += result.usage?.inputTokens ?? 0;
  acc.outputTokens += result.usage?.outputTokens ?? 0;
  acc.cachedTokens += (result.usage as { cachedTokens?: number } | null | undefined)?.cachedTokens ?? 0;
  acc.reasoningTokens += (result.usage as { reasoningTokens?: number } | null | undefined)?.reasoningTokens ?? 0;
  acc.turnCount += result.turns ?? 0;
  acc.toolCallCount += result.toolCalls?.length ?? 0;
  acc.filesReadCount += result.filesRead?.length ?? 0;
  acc.filesWrittenCount += result.filesWritten?.length ?? 0;
  if (idle) {
    if (idle.maxIdleMs > acc.maxIdleMs) acc.maxIdleMs = idle.maxIdleMs;
    acc.totalIdleMs += idle.totalIdleMs;
    acc.activityEvents += idle.activityEvents;
  }
}

export function commitReworkStage(
  stats: StageStatsMap,
  name: 'spec_rework' | 'quality_rework',
  acc: ReworkAccumulator,
  agent: { tier: 'standard' | 'complex'; model: string },
): void {
  if (!acc.occurred) return;
  (stats as Record<string, unknown>)[name] = {
    stage: name,
    entered: true,
    durationMs: acc.durationMs,
    costUSD: acc.costUSD,
    agentTier: agent.tier,
    modelFamily: modelFamily(agent.model),
    model: agent.model,
    maxIdleMs: acc.maxIdleMs,
    totalIdleMs: acc.totalIdleMs,
    activityEvents: acc.activityEvents,
    inputTokens: acc.inputTokens,
    outputTokens: acc.outputTokens,
    cachedTokens: acc.cachedTokens,
    reasoningTokens: acc.reasoningTokens,
    turnCount: acc.turnCount,
    toolCallCount: acc.toolCallCount,
    filesReadCount: acc.filesReadCount,
    filesWrittenCount: acc.filesWrittenCount,
  };
}

export function endVerifyStage(
  stats: StageStatsMap,
  t0: number,
  c0: number | null,
  agent: { tier: 'standard' | 'complex'; model: string },
  finalCostUSD: number | null,
  idle: { maxIdleMs: number; totalIdleMs: number; activityEvents: number } | null,
  outcome: VerifyOutcome,
  skipReason: VerifySkipReason | null,
): void {
  stats.verifying = {
    stage: 'verifying',
    entered: true,
    durationMs: Date.now() - t0,
    costUSD: finalCostUSD !== null && c0 !== null ? finalCostUSD - c0 : null,
    agentTier: agent.tier,
    modelFamily: modelFamily(agent.model),
    model: agent.model,
    maxIdleMs: idle?.maxIdleMs ?? 0,
    totalIdleMs: idle?.totalIdleMs ?? 0,
    activityEvents: idle?.activityEvents ?? 0,
    inputTokens: null,
    outputTokens: null,
    cachedTokens: null,
    reasoningTokens: null,
    turnCount: null,
    toolCallCount: null,
    filesReadCount: null,
    filesWrittenCount: null,
    outcome,
    skipReason,
  } as StageStatsMap['verifying'];
}

export async function executeReviewedLifecycle(
  task: TaskSpec,
  resolved: { slot: AgentType; provider: Provider; capabilityOverride: boolean },
  config: MultiModelConfig,
  taskIndex: number,
  onProgress?: RunTasksProgressCallback,
  heartbeatWiring?: { batchId?: string; recordHeartbeat?: (tick: import('../heartbeat.js').HeartbeatTickInfo) => void },
  diagnostics?: {
    logger?: import('../diagnostics/http-server-log.js').HttpServerLog;
    verbose?: boolean;
    verboseStream?: (line: string) => void;
  },
  recorder?: {
    recordTaskCompleted: (ctx: {
      route: string;
      taskSpec: TaskSpec;
      runResult: RunResult;
      client: string;
      triggeringSkill: string;
      parentModel: string | null;
      reviewPolicy?: 'full' | 'quality_only' | 'diff_only' | 'none';
      verifyCommandPresent?: boolean;
    }) => void;
  },
  _route?: string,
  _client?: string,
  _triggeringSkill?: string,
  bus?: import('../observability/bus.js').EventBus,
  qualityReviewPromptBuilder?: (ctx: { workerOutput: string; brief: string }) => string,
): Promise<RunResult> {
  const reviewPolicy = task.reviewPolicy ?? 'full';
  const routeKey = _route ?? '';

  if (reviewPolicy === 'quality_only' && !READ_ONLY_TOOL_NAMES.has(routeKey as string)) {
    throw new Error(
      `reviewPolicy 'quality_only' is only valid for read-only routes; received '${routeKey}'. ` +
      `Use 'full', 'quality_only', 'diff_only', or 'none' for artifact-producing routes.`,
    );
  }

  const otherSlot: AgentType = resolved.slot === 'standard' ? 'complex' : 'standard';
  let escalationProvider: Provider | undefined;
  try {
    escalationProvider = createProvider(otherSlot, config);
  } catch {
    escalationProvider = undefined;
  }
  const providers: Partial<Record<AgentType, Provider>> = {
    [resolved.slot]: resolved.provider,
  };
  if (escalationProvider) providers[otherSlot] = escalationProvider;

  function providerFor(tier: AgentType): Provider | undefined {
    return providers[tier];
  }

  // Compute the implementer's canonical identity. Retained for diagnostics
  // and emitFallback events; NOT used to gate reviewer separation. Separation
  // is enforced by `forbiddenTiers: [resolved.slot]` instead — what matters is
  // that the reviewer runs in a different agent_type slot, not that it uses
  // a different model. If the user configures both slots with the same model
  // (or even the same backend), the review still proceeds because the slot
  // assignment is intentional.
  const implementerIdentity = (() => {
    try { return canonicalIdentity(resolved.provider.config); } catch { return undefined; }
  })();

  // Partition filePaths into output targets before the worker runs.
  // Output targets are paths that do not yet exist on disk.
  const { outputTargets } = partitionFilePaths(task.filePaths, task.cwd ?? process.cwd());

  const stageCount =
    reviewPolicy === 'none' ? 1 :
    reviewPolicy === 'quality_only' ? 3 :
    5;
  const verbose = diagnostics?.verbose ?? false;
  const verboseStreamRaw = diagnostics?.verboseStream ?? ((line: string) => { process.stderr.write(line + '\n'); });
  const verboseBatchIdEarly = heartbeatWiring?.batchId;
  const DEFAULT_MODE_EVENTS = new Set([
    'stage_change',
    'task_done_summary',
    'fallback', 'fallback_unavailable',
    'escalation', 'escalation_unavailable',
    'stall_abort', 'cost_check', 'time_check',
  ]);
  const shortBatchEarly = verboseBatchIdEarly ? verboseBatchIdEarly.slice(0, 8) : '????????';
  type EventField = string | number | boolean | null | undefined;
  const emitTaskEvent = (event: string, fields: Record<string, EventField>): void => {
    if (bus && verboseBatchIdEarly !== undefined) {
      const schemaEvent = event === 'heartbeat_timer' ? 'task_started' : event;
      const cleaned: Record<string, EventField> = {};
      for (const [key, value] of Object.entries(fields)) {
        if (value !== undefined) cleaned[key] = value;
      }

      // Keep verbose-line field names stable while emitting schema-declared
      // telemetry envelopes in their authoritative persisted shape. EventSchemas
      // validate the full envelope at EventBus.emit in dev/test, so production
      // emission paths must construct schema-shaped keys before persistence.
      if (schemaEvent === 'task_started') {
        cleaned.route = routeKey || 'delegate';
        cleaned.cwd = task.cwd ?? process.cwd();
        for (const key of ['state', 'stage_count', 'tick_ms', 'reason']) delete cleaned[key];
      }
      if (event === 'verify_step') {
        if ('exit_code' in cleaned) { cleaned.exitCode = cleaned.exit_code; delete cleaned.exit_code; }
        if ('duration_ms' in cleaned) { cleaned.durationMs = cleaned.duration_ms; delete cleaned.duration_ms; }
        if ('error_message' in cleaned) { cleaned.errorMessage = cleaned.error_message; delete cleaned.error_message; }
      }
      if (event === 'task_completed') {
        if ('stages_json' in cleaned) { cleaned.stages = cleaned.stages_json; delete cleaned.stages_json; }
        if (!('cachedTokens' in cleaned)) cleaned.cachedTokens = null;
        if (!('reasoningTokens' in cleaned)) cleaned.reasoningTokens = null;
        if (!('stages' in cleaned)) cleaned.stages = JSON.stringify(stats);
      }

      bus.emit({ event: schemaEvent, ts: new Date().toISOString(), batchId: verboseBatchIdEarly, taskIndex, ...cleaned } as unknown as import('../observability/events.js').EventType);
    }
    if (verboseStreamRaw && (verbose || DEFAULT_MODE_EVENTS.has(event))) {
      verboseStreamRaw(composeVerboseLine({ event, ts: new Date().toISOString(), batch: shortBatchEarly, task: taskIndex, ...toVerboseFields(fields) }));
    }
  };
  // Start the heartbeat whenever there's a downstream consumer:
  // - onProgress (external progress callback from the runTasks caller)
  // - verbose (stderr stream needs the heartbeat's tool_call / turn_complete relay)
  // - recordHeartbeat (server needs heartbeat ticks to update BatchRegistry)
  // - logger (post-mortem JSONL logging needs the events too)
  // Otherwise there is no point creating a timer.
  const needHeartbeat =
    onProgress !== undefined ||
    verbose ||
    heartbeatWiring?.recordHeartbeat !== undefined ||
    diagnostics?.logger !== undefined ||
    bus !== undefined;
  // Synthesize an onProgress sink when the caller didn't pass one — the
  // heartbeat needs a place to emit heartbeat events. Discards events if
  // there is no external consumer. wrappedOnProgress (defined below) is
  // ALWAYS defined and feeds the stall watchdog regardless of consumers.
  const synthOnProgress: RunTasksProgressCallback = onProgress ?? (() => {});
  let prevCostBucket: number | null | undefined = undefined;
  let prevCounters = { tools: 0, read: 0, wrote: 0 };
  let lastNoOpEmitMs = 0;
  const heartbeat = needHeartbeat
    ? new HeartbeatTimer(
        (event) => {
          if (event.kind !== 'heartbeat') { synthOnProgress(taskIndex, event); return; }
          const tools = event.progress.toolCalls;
          const read = event.progress.filesRead;
          const wrote = event.progress.filesWritten;
          const costBucket = Number.isFinite(event.costUSD) ? Math.round(event.costUSD! * 10000) : null;
          const changed = tools !== prevCounters.tools || read !== prevCounters.read || wrote !== prevCounters.wrote || !Object.is(costBucket, prevCostBucket);
          const since = Date.now() - lastNoOpEmitMs;
          if (changed || since >= 60_000) {
            prevCounters = { tools, read, wrote };
            prevCostBucket = costBucket;
            lastNoOpEmitMs = Date.now();
            const sinceLastMs = Date.now() - prevEventAtMs;
            emitTaskEvent('heartbeat', {
              elapsed: event.elapsed,
              stage: event.stage,
              round: event.reviewRound,
              cap: event.attemptCap,
              tools: event.progress.toolCalls,
              read: event.progress.filesRead,
              wrote: event.progress.filesWritten,
              text: textEmissionChars,
              cost: event.costUSD,
              idle_ms: sinceLastMs,
              stage_idle_ms: event.stageIdleMs,
            });
          }
          synthOnProgress(taskIndex, event);
        },
        {
          provider: resolved.provider.config.model,
          parentModel: task.parentModel,
          ...(heartbeatWiring?.batchId !== undefined && { batchId: heartbeatWiring.batchId }),
          ...(heartbeatWiring?.recordHeartbeat !== undefined && { recordHeartbeat: heartbeatWiring.recordHeartbeat }),
        },
      )
    : undefined;
  heartbeat?.start(stageCount);
  emitTaskEvent('heartbeat_timer', {
    state: heartbeat ? 'started' : 'disabled',
    stage_count: stageCount,
    tick_ms: heartbeat ? 5000 : undefined,
    reason: heartbeat ? undefined : 'no_consumer',
  });

  // Stall watchdog: poll every 5s; abort if no runner event has fired for
  // stallTimeoutMs. Stops at lifecycle exit (cleared in the finally block
  // around runReviewedLifecycle's body — see end-of-function teardown).
  const stallWatchdogInterval = setInterval(() => {
    if (stallFired) return;
    const idleMs = Date.now() - lastRunnerEventAtMs;
    if (idleMs >= stallTimeoutMs) {
      stallFired = true;
      emitTaskEvent('stall_abort', { idle_ms: idleMs, threshold_ms: stallTimeoutMs });
      stallController.abort();
    }
  }, 5000);
  stallWatchdogInterval.unref?.();

  const implModel = resolved.provider.config.model;

  const progressCounters = { filesRead: 0, filesWritten: 0, toolCalls: 0 };
  let prevEventAtMs = Date.now();
  // Wrap whenever we have ANY consumer for InternalRunnerEvent (heartbeat,
  // verbose stream, or verbose logger). Previously this only wrapped when
  // the caller passed onProgress, so --verbose + HTTP handlers (which don't
  // pass onProgress) silently dropped every tool_call / turn_complete event.
  let textEmissionChars = 0;
  const markRunnerEvent = (): void => {
    const now = Date.now();
    const gap = now - stageIdle.stageLastEventMs;
    if (gap > stageIdle.stageMaxIdleMs) stageIdle.stageMaxIdleMs = gap;
    if (gap > taskMaxIdleMs) taskMaxIdleMs = gap;
    if (gap > 1000) stageIdle.stageTotalIdleMs += gap;
    stageIdle.stageActivityCount += 1;
    stageIdle.stageLastEventMs = now;
    lastRunnerEventAtMs = now;
  };
  const wrappedOnProgress = (event: InternalRunnerEvent): void => {
    // Watchdog: fire on every activity event regardless of telemetry consumers.
    // Without this, a no-consumer caller leaves lastRunnerEventAtMs frozen at
    // taskStartMs and the stall watchdog fires at stallTimeoutMs regardless of
    // actual LLM activity.
    if (event.kind === 'turn_start' || event.kind === 'text_emission' || event.kind === 'tool_call' || event.kind === 'turn_complete') {
      markRunnerEvent();
    }
    if (!needHeartbeat) return;

    if (event.kind === 'worker_start') {
          emitTaskEvent('worker_start', {
            model: event.model,
            providerType: event.providerType,
            tier: event.tier,
          });
        }
        if (event.kind === 'turn_start') {
          heartbeat?.markEvent('llm');
          prevEventAtMs = Date.now();
          if (verbose) {
            emitTaskEvent('turn_start', {
              turn: event.turn,
              provider: event.provider,
              model: event.model,
            });
          }
        }
        if (event.kind === 'text_emission') {
          prevEventAtMs = Date.now();
          heartbeat?.markEvent('text');
          textEmissionChars += event.chars;
          if (verbose && event.chars > 0) {
            const preview = event.preview.length > 60
              ? event.preview.slice(0, 57) + '...'
              : event.preview;
            emitTaskEvent('text_emission', {
              chars: event.chars,
              total: textEmissionChars,
              preview,
            });
          }
        }
        if (event.kind === 'tool_call') {
          heartbeat?.markEvent('tool');
          progressCounters.toolCalls++;
          const name = event.toolSummary.split('(')[0];
          if (name === 'readFile' || name === 'grep' || name === 'glob' || name === 'listFiles') {
            progressCounters.filesRead++;
          } else if (name === 'writeFile' || name === 'editFile') {
            progressCounters.filesWritten++;
          }
          heartbeat?.updateProgress(progressCounters.filesRead, progressCounters.filesWritten, progressCounters.toolCalls);
          const now = Date.now();
          const sincePrevMs = now - prevEventAtMs;
          prevEventAtMs = now;
          if (verbose) {
            emitTaskEvent('tool_call', {
              tool: event.toolSummary,
              duration_ms: sincePrevMs,
            });
          }
        }
        if (event.kind === 'turn_complete') {
          heartbeat?.markEvent('llm');
          const providerConfig = _activeRunnerProviderConfig ?? resolved.provider.config;
          // §3.5 point 2: per-turn delta tracking from cumulative usage
          const cur: TokenUsage = {
            inputTokens: event.cumulativeInputTokens,
            outputTokens: event.cumulativeOutputTokens,
            cachedReadTokens: event.cumulativeCachedReadTokens ?? 0,
            cachedNonReadTokens: event.cumulativeCachedNonReadTokens ?? 0,
          };
          const turnTokens = subtractTokens(cur, _lastCumulative);
          _lastCumulative = cur;
          const card = resolveRateCard(providerConfig.model, {
            ...(providerConfig.inputCostPerMTok !== undefined && { inputCostPerMTok: providerConfig.inputCostPerMTok }),
            ...(providerConfig.outputCostPerMTok !== undefined && { outputCostPerMTok: providerConfig.outputCostPerMTok }),
          });
          const turnCost = card ? priceTokens(turnTokens, card) : null;
          if (turnCost !== null) {
            _currentRunnerCostUSD = (_currentRunnerCostUSD ?? 0) + turnCost;
          } else {
            _rateCardUnresolved = true;
          }
          const cumulativeCostUSD = (_completedRunnerCostUSD ?? 0) + _currentRunnerCostUSD;
          heartbeat?.updateCost(cumulativeCostUSD, null);
          if (_rateCardUnresolved) {
            heartbeat?.markRateCardUnresolved();
          }
          const nowTurn = Date.now();
          const turnDurMs = nowTurn - prevEventAtMs;
          prevEventAtMs = nowTurn;
          if (verbose) {
            emitTaskEvent('turn_complete', {
              input_tokens: event.cumulativeInputTokens,
              output_tokens: event.cumulativeOutputTokens,
              cost: turnCost,
              duration_ms: turnDurMs,
              provider: providerConfig.model,
            });
          }
        }
      };

  const cwd = task.cwd ?? process.cwd();
  const taskStartMs = Date.now();
  // Hard task-level wall-clock cap. Once Date.now() crosses this, no new
  // provider.run is dispatched (retries / tier-fallback short-circuit) and
  // any in-flight call gets a per-call timeoutMs clamped to remaining
  // budget so it returns its salvage promptly. The user gets *something*
  // back instead of an open-ended retry storm.
  const taskTimeoutMs = task.timeoutMs ?? config.defaults?.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
  const taskDeadlineMs = taskStartMs + taskTimeoutMs;
  // Stall watchdog: when no LLM / tool / text event has fired for this
  // many ms, the in-flight runner is force-aborted via `stallController`.
  // Catches "model is silently thinking forever" and "transport hung" —
  // both invisible to the wall-clock cap until the very end.
  const stallTimeoutMs = config.defaults.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
  const stallController = new AbortController();
  let lastRunnerEventAtMs = taskStartMs;
  let stageIdle: StageIdleTracker = newStageIdleTracker(taskStartMs);
  let taskMaxIdleMs = 0;
  let stallFired = false;

  type HeartbeatTransitionPayload = Parameters<NonNullable<typeof heartbeat>['transition']>[0];

  // Track the current stage so the terminal transition can pass an accurate
  // `from`. Initialized to 'implementing' (matching HeartbeatTimer.start's
  // initial stage). Updated on every transitionStage call.
  let currentStage: import('../heartbeat.js').HeartbeatStage = 'implementing';

  function transitionStage(
    from: import('../types.js').StageName | 'terminal',
    to:   import('../heartbeat.js').HeartbeatStage,
    heartbeatPayload: HeartbeatTransitionPayload | null,
    jsonlPayload: Record<string, EventField> | null,
  ): void {
    if (heartbeatPayload !== null) heartbeat?.transition(heartbeatPayload);
    if (jsonlPayload !== null) {
      emitTaskEvent('stage_change', { from, to, ...jsonlPayload });
    }
    stageIdle = newStageIdleTracker(Date.now());
    currentStage = to;
  }
  const commits: Commit[] = [];
  let commitError: string | undefined;
  let specAttemptIndex = 0;
  let qualityAttemptIndex = 0;
  const maxSpecRows = maxRowsFor('spec');
  const maxQualityRows = maxRowsFor('quality');
  const specUnavailable: UnavailableMap = new Map();
  let qualityUnavailable: UnavailableMap = new Map();
  let metadataRepair = 0;
  const maxCostUSD = task.maxCostUSD;
  const implementerHistory: AgentType[] = [];
  const specReviewerHistory: (AgentType | 'skipped')[] = [];
  const qualityReviewerHistory: (AgentType | 'skipped')[] = [];
  const fallbackOverrides: FallbackOverride[] = [];
  let latestAttemptedImpl: { tier: AgentType; result: RunResult } | undefined;
  let lastNonRejectedImpl: { tier: AgentType; result: RunResult } | undefined;
  // Review-stage timing variables hoisted so deferred-finalizer closures
  // (defined below) can reference them from all early-exit paths.
  let specReviewT0 = 0;
  let specReviewC0: number | null = null;
  let specReviewDurationMs = 0;
  let qualityReviewT0 = 0;
  let qualityReviewC0: number | null = null;
  let qualityReviewDurationMs = 0;
  // Accumulated metrics from spec/quality review results — threaded to
  // the deferred finalizers so early-exit paths carry the same token/turn
  // counts the normal post-loop path always had.
  let specReviewMetrics: Record<string, unknown> = {};
  let qualityReviewMetrics: Record<string, unknown> = {};
  // Hoisted so deferred-finalizer closures (defined below) can reference
  // these from all early-exit paths. Reassigned after the corresponding
  // review stage runs.
  let specStatus: string = 'error';
  let qualityResult: LegacyQualityReviewResult = { status: 'skipped', report: undefined, findings: [], errorReason: (reviewPolicy === 'full' || reviewPolicy === 'quality_only') ? 'all_tiers_unavailable' : 'skipped: reviewPolicy is diff_only or none' };
  const reviewRounds = () => ({ spec: specAttemptIndex, quality: qualityAttemptIndex, metadata: metadataRepair, cap: Math.max(maxSpecRows, maxQualityRows) });
  const taskCostUSD = () => (heartbeat ? heartbeat.getHeartbeatTickInfo().costUSD : null);

  // Per-stage stats tracking
  const stats = emptyStats();
  const resolvedModel = config.agents[resolved.slot].model;
  const implementerAgentInfo = {
    tier: resolved.slot,
    family: modelFamily(resolvedModel),
    model: resolvedModel,
  };

  // Build agent info for a specific reviewer tier. Used so review-stage
  // entries record the ACTUAL reviewer's model, not the implementer's
  // — V3 R3 (review.model != implementerModel) requires this to be
  // the cross-model invariant we claim. Pre-3.10.4 every endReviewStage
  // call hardcoded implementerAgentInfo, so R3 always fired by
  // construction regardless of config.
  const reviewerAgentInfoFor = (tier: AgentType): { tier: AgentType; family: ReturnType<typeof modelFamily>; model: string } => {
    const provider = providerFor(tier);
    const model = provider?.config.model ?? config.agents[tier]?.model ?? resolvedModel;
    return { tier, family: modelFamily(model), model };
  };
  // Deferred finalizers for spec_review and quality_review. Called from
  // the normal post-loop path AND from every early-exit path
  // (round_cap, cost_ceiling, time_ceiling, all_tiers_unavailable).
  // Idempotent on re-call; no-op when the stage was never started.
  let specReviewFinalized = false;
  let qualityReviewFinalized = false;

  const finalizeSpecReviewStage = (): void => {
    if (specReviewFinalized) return;
    if (specReviewT0 === 0) return;  // never started
    specReviewFinalized = true;
    const lastReviewer = specReviewerHistory[specReviewerHistory.length - 1];
    const reviewerAgent = (lastReviewer === undefined || lastReviewer === 'skipped')
      ? implementerAgentInfo
      : reviewerAgentInfoFor(lastReviewer);
    endReviewStage(stats, 'spec_review', specReviewT0, specReviewC0, reviewerAgent,
      runningCostUSD(), snapshotIdle(stageIdle),
      specStatus === 'approved' ? 'approved'
        : specStatus === 'changes_required' ? 'changes_required'
        : specStatus === 'skipped' ? 'skipped'
        : specStatus === 'not_applicable' ? 'not_applicable'
        : 'error',
      specAttemptIndex,
      { ...specReviewMetrics, durationMs: specReviewDurationMs });
  };

  const finalizeQualityReviewStage = (): void => {
    if (qualityReviewFinalized) return;
    if (qualityReviewT0 === 0) return;
    if (reviewPolicy !== 'full' && reviewPolicy !== 'quality_only') return;
    qualityReviewFinalized = true;
    const lastReviewer = qualityReviewerHistory[qualityReviewerHistory.length - 1];
    const reviewerAgent = (lastReviewer === undefined || lastReviewer === 'skipped')
      ? implementerAgentInfo
      : reviewerAgentInfoFor(lastReviewer);
    endReviewStage(stats, 'quality_review', qualityReviewT0, qualityReviewC0, reviewerAgent,
      runningCostUSD(), snapshotIdle(stageIdle),
      qualityResult.status === 'approved' ? 'approved'
        : qualityResult.status === 'changes_required' ? 'changes_required'
        : qualityResult.status === 'annotated' ? 'annotated'
        : qualityResult.status === 'skipped' ? 'skipped'
        : 'error',
      qualityAttemptIndex,
      { ...qualityReviewMetrics, durationMs: qualityReviewDurationMs });
  };
  // §3.9: runningCostUSD must be cumulative and monotonic across explicit
  // runner boundaries. Runner progress reports per-runner cumulative token
  // counts, so lifecycle cost is completed runners + current runner partial.
  // Boundaries are closed from actual RunResult.usage.costUSD values rather
  // than inferred from drops; this handles reviewer costs greater than the
  // implementer and preserves reviewer-provider pricing.
  let _completedRunnerCostUSD: number | null = null;
  let _currentRunnerCostUSD = 0;
  let _activeRunnerProviderConfig: Provider['config'] | null = null;
  let _prevRunningCost: number | null = null;
  // Per-turn delta tracking state (§3.5 point 2). Reset at each
  // provider.run() boundary via `runAccounted`.
  let _lastCumulative: TokenUsage = {
    inputTokens: 0, outputTokens: 0,
    cachedReadTokens: 0, cachedNonReadTokens: 0,
  };
  let _rateCardUnresolved = false;
  const runningCostUSD = () => {
    const current = _completedRunnerCostUSD !== null || _currentRunnerCostUSD !== 0
      ? (_completedRunnerCostUSD ?? 0) + _currentRunnerCostUSD
      : null;
    if (process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development') {
      if (_prevRunningCost !== null && current !== null && current < _prevRunningCost) {
        throw new Error(`runningCostUSD non-monotonic: prev=${_prevRunningCost} now=${current}`);
      }
      _prevRunningCost = current;
    }
    return current;
  };
  const runAccounted = async <T>(provider: Provider, call: () => Promise<T>): Promise<T> => {
    if (_activeRunnerProviderConfig !== null) {
      throw new Error('lifecycle cost accounting runner overlap');
    }
    _activeRunnerProviderConfig = provider.config;
    _currentRunnerCostUSD = 0;
    _lastCumulative = {
      inputTokens: 0, outputTokens: 0,
      cachedReadTokens: 0, cachedNonReadTokens: 0,
    };
    _rateCardUnresolved = false;
    try {
      const result = await call();
      const actualCost = (result as { usage?: { costUSD?: number | null } | null; metrics?: { costUSD?: number | null } } | null)?.usage?.costUSD
        ?? (result as { metrics?: { costUSD?: number | null } } | null)?.metrics?.costUSD
        ?? _currentRunnerCostUSD;
      _completedRunnerCostUSD = (_completedRunnerCostUSD ?? 0) + actualCost;
      _currentRunnerCostUSD = 0;
      heartbeat?.updateCost(_completedRunnerCostUSD, null);
      return result;
    } finally {
      _activeRunnerProviderConfig = null;
    }
  };
  const policyEscalated: { spec: boolean; quality: boolean; diff: boolean } = { spec: false, quality: false, diff: false };
  const emitFallback = (p: FallbackEventParams) => {
    emitTaskEvent('fallback', p as unknown as Record<string, EventField>);
  };
  const emitFallbackUnavailable = (p: FallbackUnavailableEventParams) => {
    emitTaskEvent('fallback_unavailable', p as unknown as Record<string, EventField>);
  };
  const emitEscalationEvent = (
    loop: 'spec' | 'quality' | 'diff',
    attempt: number,
    decision: { impl: AgentType; reviewer: AgentType },
  ) => {
    const p: EscalationEventParams = {
      batchId: heartbeatWiring?.batchId ?? '', taskIndex, loop, attempt,
      baseTier: resolved.slot, implTier: decision.impl, reviewerTier: decision.reviewer,
    };
    emitTaskEvent('escalation', p as unknown as Record<string, EventField>);
    policyEscalated[loop] = true;
  };
  const emitEscalationUnavailable = (p: EscalationUnavailableEventParams) => {
    emitTaskEvent('escalation_unavailable', p as unknown as Record<string, EventField>);
  };
  // When the review loop aborts mid-flight, preserve any review-status info already set
  // on the base result (set by callers via abortReviewLoop({ ...res, specReviewStatus, ... })).
  // Defaults to 'changes_required' for whichever loop tripped — that's the only state the
  // loop ever fires from, by construction.
  function adaptForAllTiersUnavailable(base: RunResult, loop: 'spec' | 'quality', attempt: number, resolvedModel: string, salvageSource: RunResult | null, unavailableReason?: FallbackReason): RunResult {
    const stageName = loop === 'spec' && attempt === 0 ? 'implementing'
      : loop === 'spec' ? 'spec_rework'
      : 'quality_rework';

    // Promote salvage stage stats + metrics into the global stats map so R2.1
    // (non-empty stages for 'incomplete') passes even when bothUnavailable
    // short-circuits before endBaseStage runs at the call site.
    if (salvageSource?.stageStats) {
      for (const key of Object.keys(salvageSource.stageStats) as (keyof StageStatsMap)[]) {
        const val = salvageSource.stageStats[key];
        if (val) (stats as Record<string, unknown>)[key] = val;
      }
    }

    const existing = (stats as Record<string, unknown>)[stageName] as { entered?: boolean; durationMs?: unknown; costUSD?: unknown } | undefined;
    if (!existing?.entered) {
      (stats as Record<string, unknown>)[stageName] = {
        stage: stageName,
        entered: true,
        durationMs: existing?.durationMs ?? salvageSource?.durationMs ?? null,
        costUSD: existing?.costUSD ?? salvageSource?.cost?.costUSD ?? null,
        agentTier: implementerAgentInfo.tier,
        modelFamily: modelFamily(implementerAgentInfo.model),
        model: implementerAgentInfo.model,
        maxIdleMs: 0,
        totalIdleMs: 0,
        activityEvents: 0,
        inputTokens: salvageSource?.usage?.inputTokens ?? null,
        outputTokens: salvageSource?.usage?.outputTokens ?? null,
        cachedTokens: null,
        reasoningTokens: null,
        turnCount: salvageSource?.turns ?? null,
        toolCallCount: (salvageSource?.toolCalls?.length) || null,
        filesReadCount: (salvageSource?.filesRead?.length) || null,
        filesWrittenCount: (salvageSource?.filesWritten?.length) || null,
      };
    }

    finalizeSpecReviewStage();
    finalizeQualityReviewStage();
    const ship = salvageSource ?? lastNonRejectedImpl?.result ?? base;
    return {
      ...ship,
      status: 'incomplete',
      workerStatus: 'blocked',
      terminationReason: 'all_tiers_unavailable',
      reviewRounds: reviewRounds(),
      error: `runWithFallback: both tiers unavailable (loop=${loop}, attempt=${attempt}, role=implementer)`,
      errorCode: unavailableReason === 'reviewer_separation_unsatisfiable' ? 'reviewer_separation_unsatisfiable' : (ship as RunResult).errorCode,
      agents: agentEnvelope(
        specReviewerHistory[specReviewerHistory.length - 1] ?? 'not_applicable',
        qualityReviewerHistory[qualityReviewerHistory.length - 1] ?? ((reviewPolicy === 'full' || reviewPolicy === 'quality_only') ? 'not_applicable' : 'skipped'),
      ),
      stageStats: stats,
      models: {
        implementer: salvageSource?.models?.implementer
          ?? (salvageSource?.stageStats?.[stageName] as { model?: string | null } | undefined)?.model
          ?? resolvedModel,
        specReviewer: ship.models?.specReviewer ?? null,
        qualityReviewer: ship.models?.qualityReviewer ?? null,
      },
    } as RunResult;
  }

  function reviewDidNotReject(status: string): boolean {
    return status === 'approved' || status === 'skipped';
  }

  const implementerToolMode = task.tools ?? config.defaults.tools;
  const agentConfig = config.agents[resolved.slot];
  const implementerCapabilities = (agentConfig.capabilities ?? findModelCapabilities(agentConfig.model) ?? []) as ('web_search' | 'web_fetch')[];

  const agentEnvelope = (specReviewer: AgentType | 'skipped' | 'not_applicable', qualityReviewer: AgentType | 'skipped' | 'not_applicable') => {
    // Identity = the slot the executor *resolved to* before any per-call
    // fallback flips. This must match `stats.implementing.agentTier`
    // (which uses `resolved.slot` directly at line ~697). Per-call slot
    // drift is recorded in `fallbackOverrides` and `implementerHistory`,
    // not by mutating implementer identity. Pre-3.12.3 used
    // latestAttemptedImpl.tier here, which silently disagreed with
    // stage stats whenever runWithFallback flipped tiers.
    const implementer = resolved.slot;
    return {
      implementer,
      ...(implementerHistory.length > 1 || implementerHistory.some(t => t !== implementer) ? { implementerHistory } : {}),
      implementerToolMode,
      implementerCapabilities,
      specReviewer,
      ...(specReviewerHistory.length > 0 && (specReviewerHistory.length > 1 || specReviewerHistory.some(t => t === 'skipped')) ? { specReviewerHistory } : {}),
      qualityReviewer,
      ...(qualityReviewerHistory.length > 0 && (qualityReviewerHistory.length > 1 || qualityReviewerHistory.some(t => t === 'skipped')) ? { qualityReviewerHistory } : {}),
      ...(fallbackOverrides.length > 0 ? { fallbackOverrides } : {}),
    };
  };

  const abortReviewLoop = (
    base: RunResult,
    terminationReason: 'round_cap' | 'cost_ceiling' | 'time_ceiling',
    message: string,
    aborting: 'spec' | 'quality',
    wallClockMs?: number,
  ): RunResult => {
    finalizeSpecReviewStage();
    finalizeQualityReviewStage();
    return {
      ...base,
      status: 'incomplete',
      workerStatus: 'review_loop_capped',
      terminationReason: terminationReason === 'round_cap'
        ? 'round_cap'
        : {
            cause: terminationReason === 'cost_ceiling' ? 'cost_exceeded' : 'time_ceiling',
            turnsUsed: base.turns,
            hasFileArtifacts: (base.filesWritten ?? []).length > 0,
            usedShell: (base.toolCalls ?? []).some(c => c.startsWith('shell') || c.startsWith('runShell')),
            workerSelfAssessment: 'review_loop_capped',
            wasPromoted: false,
            ...(wallClockMs !== undefined ? { wallClockMs } : {}),
          },
      reviewRounds: reviewRounds(),
      error: message,
      specReviewStatus: aborting === 'spec' ? 'changes_required' : (base.specReviewStatus ?? 'approved'),
      qualityReviewStatus: aborting === 'quality' ? 'changes_required' : (base.qualityReviewStatus ?? 'skipped'),
      agents: agentEnvelope(
        specReviewerHistory[specReviewerHistory.length - 1] ?? 'not_applicable',
        qualityReviewerHistory[qualityReviewerHistory.length - 1] ?? ((reviewPolicy === 'full' || reviewPolicy === 'quality_only') ? 'not_applicable' : 'skipped'),
      ),
      stageStats: stats,
    };
  };
  const defaultVerification: VerifyStageResult = { status: 'skipped', steps: [], totalDurationMs: 0, skipReason: 'no_command' };
  let latestVerification: VerifyStageResult = defaultVerification;

  async function runVerificationStage(): Promise<VerifyStageResult> {
    transitionStage('implementing', 'verifying', { stage: 'verifying', stageIndex: 4 }, {});
    const overallVerificationStart = Date.now();
    const verifyCostStart = runningCostUSD();
    const verification = await runVerifyStage({
      cwd,
      verifyCommand: task.verifyCommand,
      taskTimeoutMs: task.timeoutMs ?? config.defaults?.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS,
      taskStartMs,
    });
    latestVerification = verification;
    endVerifyStage(stats, overallVerificationStart, verifyCostStart,
      implementerAgentInfo, runningCostUSD(), snapshotIdle(stageIdle),
      verification.status === 'passed' ? 'passed'
        : verification.status === 'failed' ? 'failed'
        : verification.status === 'skipped' ? 'skipped'
        : 'not_applicable',
      (verification as any).skipReason ?? null);
    for (const step of verification.steps) {
      emitTaskEvent('verify_step', {
        command: step.command,
        status: step.status,
        exit_code: step.exitCode,
        signal: step.signal,
        duration_ms: step.durationMs,
        error_message: step.errorMessage ?? undefined,
      });
    }
    if (verification.status === 'skipped') {
      emitTaskEvent('verify_skipped', { reason: verification.skipReason ?? 'no_command', stage: 'verifying' });
    }
    return verification;
  }

  function signalize(result: RunResult): RunResult {
    const cause = typeof result.terminationReason === 'object' ? result.terminationReason.cause : result.terminationReason;
    const capExhausted = result.capExhausted
      ?? (result.status === 'cost_exceeded' || cause === 'cost_exceeded' || cause === 'cost_ceiling' ? 'cost'
        : result.status === 'timeout' || cause === 'timeout' || cause === 'time_ceiling' ? 'wall_clock'
          : result.status === 'incomplete' && result.turns > 1 ? 'turn'
            : undefined);
    const lifecycleClarificationRequested = result.lifecycleClarificationRequested
      ?? (result.status === 'brief_too_vague' || cause === 'brief_too_vague' ? true : undefined);
    return {
      ...result,
      ...(capExhausted !== undefined && { capExhausted }),
      ...(lifecycleClarificationRequested !== undefined && { lifecycleClarificationRequested }),
    };
  }

  function workerErrorResult(err: unknown): RunResult {
    const workerError = err instanceof Error ? err : new Error(String(err));
    return signalize({
      output: '',
      status: 'error',
      usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 },
      turns: 0,
      filesRead: [],
      filesWritten: [],
      toolCalls: [],
      outputIsDiagnostic: true,
      escalationLog: [],
      parsedFindings: null,
      error: workerError.message,
      errorCode: 'runner_crash',
      structuredError: { code: 'runner_crash', message: workerError.message },
      workerStatus: 'failed',
      workerError,
      models: {
        implementer: implModel,
        specReviewer: null,
        qualityReviewer: null,
      },
    });
  }

  function withVerification(result: RunResult, verification = latestVerification): RunResult {
    return signalize({ ...result, verification, stageStats: stats });
  }

  function verificationErrorResult(base: RunResult, verification: VerifyStageResult): RunResult | null {
    if (verification.status !== 'error') return null;
    const failedIndex = verification.steps.findIndex((step) => step.status !== 'passed');
    const failedStep = failedIndex >= 0 ? verification.steps[failedIndex] : undefined;
    return withVerification({
      ...base,
      status: 'error',
      workerStatus: 'done_with_concerns',
      error: failedStep?.errorMessage ?? 'verify command error',
      errorCode: 'validator_verify_command_failed',
      commits,
      commitError,
      verification,
    }, verification);
  }

  function resolveOffTerminal(base: RunResult, verification: VerifyStageResult): RunResult {
    const concerns = [...(base.concerns ?? [])];
    let workerStatus = workerStatusForTerminal(base.workerStatus);
    if (verification.status === 'failed') {
      concerns.push({
        source: 'verification',
        severity: 'high',
        message: 'Verification failed after implementation.',
      });
      workerStatus = 'done_with_concerns';
    }
    if (verification.status === 'error') {
      const failedIndex = verification.steps.findIndex((step) => step.status !== 'passed');
      const failedStep = failedIndex >= 0 ? verification.steps[failedIndex] : undefined;
      return withVerification({
        ...base,
        status: 'error',
        workerStatus: 'failed',
        error: failedStep?.errorMessage ?? 'verify command error',
        errorCode: 'validator_verify_command_failed',
        commits,
        commitError,
        verification,
      }, verification);
    }
    return withVerification({
      ...base,
      status: base.status === 'ok' ? 'ok' : base.status,
      workerStatus,
      concerns,
      commits,
      commitError,
      verification,
      stageStats: stats,
    }, verification);
  }

  function diffReviewErrorTerminationReason(base: RunResult) {
    return {
      cause: 'error' as const,
      turnsUsed: base.turns,
      hasFileArtifacts: (base.filesWritten ?? []).length > 0,
      usedShell: (base.toolCalls ?? []).some(c => c.startsWith('shell') || c.startsWith('runShell')),
      workerSelfAssessment: 'failed' as const,
      wasPromoted: false,
      ...(base.terminationReason && typeof base.terminationReason === 'object' && base.terminationReason.wallClockMs !== undefined ? { wallClockMs: base.terminationReason.wallClockMs } : {}),
    };
  }

  function resolveDiffOnlyTerminal(base: RunResult, verdict: DiffReviewOrSkipped, verification: VerifyStageResult, diffTruncated: boolean): RunResult {
    const concerns = [...(base.concerns ?? [])];
    if ('status' in verdict && verdict.status === 'skipped') {
      return withVerification({
        ...base,
        workerStatus: workerStatusForTerminal(base.workerStatus),
        commits,
        commitError,
        verification,
      }, verification);
    }
    if (verdict.kind === 'reject') {
      return withVerification({
        ...base,
        status: 'error',
        workerStatus: 'failed',
        error: verdict.message || 'diff review rejected implementation',
        errorCode: 'diff_review_rejected',
        structuredError: {
          code: 'diff_review_rejected',
          message: verdict.message || 'diff review rejected implementation',
        },
        terminationReason: diffReviewErrorTerminationReason(base),
        concerns,
        commits,
        commitError,
        verification,
      }, verification);
    }
    if (verdict.kind === 'transport_failure') {
      return withVerification({
        ...base,
        status: verdict.status,
        workerStatus: 'failed',
        error: verdict.reason ?? `diff review transport failure: ${verdict.status}`,
        errorCode: verdict.status,
        structuredError: {
          code: verdict.status,
          message: verdict.reason ?? `diff review transport failure: ${verdict.status}`,
        },
        terminationReason: diffReviewErrorTerminationReason(base),
        concerns: [...concerns, ...verdict.concerns],
        commits,
        commitError,
        verification,
      }, verification);
    }
    concerns.push(...verdict.concerns);
    if (verification.status === 'failed') {
      concerns.push({
        source: 'verification',
        severity: 'high',
        message: 'Verification failed after implementation.',
      });
    }
    if (diffTruncated) {
      concerns.push({
        source: 'diff_truncated',
        severity: 'medium',
        message: 'Implementation diff exceeded the reviewer evidence byte cap and was truncated.',
      });
    }
    const hasConcerns = concerns.length > 0 || verification.status === 'failed';
    return withVerification({
      ...base,
      status: base.status === 'ok' ? 'ok' : base.status,
      workerStatus: hasConcerns ? 'done_with_concerns' : workerStatusForTerminal(base.workerStatus),
      concerns,
      commits,
      commitError,
      verification,
    }, verification);
  }

  function workerStatusForTerminal(status: RunResult['workerStatus']): RunResult['workerStatus'] {
    return status === 'needs_context' || status === 'blocked' || status === 'failed' || status === 'done_with_concerns'
      ? status
      : 'done';
  }

  async function recordWorkerCommits(from: string, to = 'HEAD'): Promise<void> {
    const { stdout: revs } = await exec('git', ['rev-list', '--reverse', `${from}..${to}`], { cwd });
    for (const sha of revs.trim().split('\n').filter(Boolean)) {
      const c = await readbackCommit(sha, cwd);
      commits.push(c);
    }
  }

  async function repairCommitMetadata(initialDiagnostic: string): Promise<CommitFields | null> {
    let metadataAttempts = 0;
    let lastZodError = initialDiagnostic || 'no commit block emitted';
    let validCommit: CommitFields | null = null;
    while (metadataAttempts < 2 && !validCommit) {
      const preStatus = (await exec('git', ['status', '--porcelain=v1', '-z'], { cwd })).stdout;
      const repaired = await runMetadataRepairTurn({ task, zodError: lastZodError, cwd, providerSlot: resolved.slot, provider: resolved.provider });
      const postStatus = (await exec('git', ['status', '--porcelain=v1', '-z'], { cwd })).stdout;
      metadataAttempts += 1;
      if (preStatus !== postStatus) {
        commitError = 'commit_metadata_repair_modified_files';
        return null;
      }
      if (repaired.commit) validCommit = repaired.commit;
      else lastZodError = repaired.commitDiagnostic ?? 'no commit block emitted';
    }
    if (!validCommit) commitError = `commit_metadata_invalid: ${lastZodError}`;
    return validCommit;
  }

  async function captureCommitsAfterImplementation(implResult: RunResult, implReport: ReturnType<typeof parseStructuredReport> | undefined, baselineHead: string): Promise<void> {
    const porcelain = (await exec('git', ['status', '--porcelain=v1'], { cwd })).stdout;
    const headNow = (await exec('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim();
    const headMoved = headNow !== baselineHead;
    const treeDirty = porcelain.length > 0;
    if (!headMoved && !treeDirty) return;

    // Emit committing stage for both worker-committed (headMoved) and
    // pending-commit (treeDirty) paths. Workers that auto-commit during
    // turns leave a clean tree but moved HEAD — they must still produce
    // a committing stage so telemetry includes filesCommittedCount.
    transitionStage('verifying', 'committing', { stage: 'committing', stageIndex: 7 }, null);
    const commitT0 = Date.now();
    const commitC0 = runningCostUSD();

    if (headMoved) await recordWorkerCommits(baselineHead, 'HEAD');
    if (treeDirty) {
      const validCommit = implReport?.commit ?? await repairCommitMetadata(implReport?.commitDiagnostic ?? 'no commit block emitted');
      if (validCommit) {
        const c = await runCommitStage({ cwd, filesWritten: implResult.filesWritten, commit: validCommit });
        commits.push(c);
      }
    }

    endBaseStage(stats, 'committing', commitT0, commitC0, implementerAgentInfo, runningCostUSD(), snapshotIdle(stageIdle));
  }

  // Tracks the final RunResult across every exit path so the `finally` block
  // below fires `recorder.recordTaskCompleted` exactly once regardless of which
  // `return` the lifecycle takes — the success path, every early return inside
  // the try (reviewPolicy='none', diff-only, all-tiers-unavailable, …), and the
  // catch path. Without this, the recorder only fires on 2 of ~5 exit paths.
  let __finalRunResult: RunResult | undefined;
  const __recordOnce = (r: RunResult): RunResult => {
    // Stamp stallTriggered and taskMaxIdleMs on every exit path.
    // The watchdog flag is owned by this scope; surfacing it on the
    // RunResult lets the caller (and telemetry) distinguish "no progress"
    // aborts from cap exhaustion. taskMaxIdleMs is always populated so the
    // task_completed JSONL event has it regardless of early return.
    const stamped: RunResult = {
      ...r,
      ...(stallFired ? { stallTriggered: true } : {}),
      taskMaxIdleMs,
    };
    if (__finalRunResult === undefined) __finalRunResult = stamped;
    return stamped;
  };

  try {
    // The dirty-tree precondition + git baseline only apply to artifact-producing tasks
    // (those with autoCommit === true). Non-artifact presets — audit, review, verify,
    // debug — neither produce commits nor read git state, so they bypass the check
    // entirely. Per spec Section A: "Non-artifact tasks (audits, analyses, read-only
    // investigations) skip stages 3 and 4."
    const isArtifactProducing = task.autoCommit === true;
    let baselineHead = '';
    if (isArtifactProducing) {
      baselineHead = (await exec('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim();
      const baselinePorcelain = (await exec('git', ['status', '--porcelain=v1', '-z'], { cwd })).stdout;
      if (baselinePorcelain.length !== 0) {
        return withVerification({
          output: `Sub-agent error: task.cwd ${cwd} had pre-existing modifications`,
          status: 'error',
          usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 },
          turns: 0,
          filesRead: [],
          filesWritten: [],
          toolCalls: [],
          outputIsDiagnostic: true,
          escalationLog: [],
          parsedFindings: null,
          error: `task.cwd ${cwd} had pre-existing modifications`,
          errorCode: 'validator_dirty_worktree',
          commits,
        });
      }
    }

    const initialDecision = pickEscalation({
      loop: 'spec',
      attemptIndex: 0,
      baseTier: resolved.slot,
    });
    const implT0 = Date.now();
    const implC0 = runningCostUSD();
    const initialImpl = await runWithFallback<RunResult>({
      assigned: initialDecision.impl,
      providerFor,
      unavailableTiers: specUnavailable,
      isTransportFailure: (r) => TRANSPORT_FAILURES.has(r.status) && r.capExhausted === undefined,
      getStatus: (r) => r.status,
      makeSyntheticFailure: (assigned) => makeSyntheticRunResult(assigned, 'all_tiers_unavailable'),
      call: (provider) => runAccounted(provider, () => delegateWithEscalation(
        withDoneCondition(task),
        [provider],
        { explicitlyPinned: false, onProgress: wrappedOnProgress, taskDeadlineMs, abortSignal: stallController.signal, assignedTier: initialDecision.impl },
      )),
    });

    if (initialImpl.fallbackFired || initialImpl.bothUnavailable) {
      fallbackOverrides.push({
        role: 'implementer',
        loop: 'spec',
        attempt: 0,
        assigned: initialDecision.impl,
        used: initialImpl.usedTier,
        reason: (initialImpl.fallbackReason ?? initialImpl.unavailableReason)!,
        triggeringStatus: initialImpl.fallbackTriggeringStatus,
        bothUnavailable: initialImpl.bothUnavailable,
      });
    }
    if (initialImpl.fallbackFired) {
      emitFallback({
        batchId: heartbeatWiring?.batchId ?? '', taskIndex,
        loop: 'spec', attempt: 0, role: 'implementer',
        assignedTier: initialDecision.impl,
        usedTier: initialImpl.usedTier as AgentType,
        reason: initialImpl.fallbackReason!,
        triggeringStatus: initialImpl.fallbackTriggeringStatus,
        violatesSeparation: false,
      });
    }
    if (initialImpl.bothUnavailable) {
      emitFallbackUnavailable({
        batchId: heartbeatWiring?.batchId ?? '', taskIndex,
        loop: 'spec', attempt: 0, role: 'implementer',
        assignedTier: initialDecision.impl,
        reason: initialImpl.unavailableReason!,
      });
      return __recordOnce(adaptForAllTiersUnavailable(initialImpl.result, 'spec', 0, resolvedModel, initialImpl.salvageResult, initialImpl.unavailableReason));
    }

    let implResult = initialImpl.result;
    latestAttemptedImpl = { tier: initialImpl.usedTier as AgentType, result: implResult };
    lastNonRejectedImpl = { tier: initialImpl.usedTier as AgentType, result: implResult };
    implementerHistory.push(initialImpl.usedTier as AgentType);

    endBaseStage(stats, 'implementing', implT0, implC0, implementerAgentInfo, runningCostUSD(), snapshotIdle(stageIdle), {
      inputTokens: implResult.usage?.inputTokens ?? 0,
      outputTokens: implResult.usage?.outputTokens ?? 0,
      cachedTokens: ((implResult.usage?.cachedReadTokens ?? 0) + (implResult.usage?.cachedNonReadTokens ?? 0)) || undefined,
      reasoningTokens: undefined,
      turnCount: implResult.turns,
      toolCallCount: implResult.toolCalls?.length ?? 0,
      filesReadCount: implResult.filesRead?.length ?? 0,
      filesWrittenCount: implResult.filesWritten?.length ?? 0,
      costUSD: implResult.cost?.costUSD ?? undefined,
    });
    specAttemptIndex = 1;

    const implReport = parseStructuredReport(implResult.output);
    const workerStatus = extractWorkerStatus(implReport);
    // Item 9: surface silent-incomplete via errorCode — the delegation layer
    // cascades result.status as a fallback errorCode (e.g., 'incomplete'),
    // which is not an informative error code. Replace it when the runner
    // produced no parseable summary — the operator can now filter on
    // 'incomplete_no_summary' instead of guessing.
    //
    // parseStructuredReport always returns a report object and has a
    // last-resort fallback that treats the first paragraph as an implicit
    // summary, so implReport.summary alone is not a reliable signal. Treat
    // the run as having a structured summary only when a real ## Summary
    // section exists and parses to non-placeholder content.
    const hasSummaryHeader = /\n##\s+summary\s*\n/i.test(implResult.output) || /^##\s+summary\s*\n/im.test(implResult.output);
    const summaryText = (hasSummaryHeader ? implReport.summary : null)?.trim().toLowerCase() ?? '';
    const hasStructuredSummary = hasSummaryHeader && summaryText !== ''
      && !['none', '(none)', 'n/a', 'na', 'todo', 'tbd'].includes(summaryText);
    if (implResult.status === 'incomplete' && !hasStructuredSummary) {
      const cascadedFallback = implResult.errorCode === implResult.status;
      if (!implResult.errorCode || cascadedFallback) {
        implResult = { ...implResult, errorCode: 'incomplete_no_summary' };
      }
    }

    if (implResult.status === 'ok' && isArtifactProducing) {
      await captureCommitsAfterImplementation(implResult, implReport, baselineHead);
    }

    const verification = isArtifactProducing ? await runVerificationStage() : defaultVerification;
    const verifyError = verificationErrorResult(implResult, verification);
    if (verifyError) return verifyError;

    const filePathsInteracted = task.filePaths && task.filePaths.length > 0
      ? [...(implResult.filesRead ?? []), ...implResult.filesWritten].some(f =>
          task.filePaths!.some(fp => f === fp || f.endsWith('/' + fp) || f.endsWith(fp)),
        )
      : true;
    const filePathsSkipped = !filePathsInteracted;

    if (implResult.filesWritten.length === 0 && reviewPolicy !== 'quality_only') {
      if (reviewPolicy === 'none') {
        transitionStage('verifying', 'terminal', null, {});
        const terminal = resolveOffTerminal({
          ...implResult,
          workerStatus,
          specReviewStatus: 'skipped',
          qualityReviewStatus: 'skipped',
          specReviewReason: 'skipped: reviewPolicy is none',
          qualityReviewReason: 'skipped: reviewPolicy is none',
          agents: agentEnvelope('skipped', 'skipped'),
          models: {
            implementer: implModel,
            specReviewer: null,
            qualityReviewer: null,
          },
          implementationReport: implReport,
          structuredReport: implReport,
          filePathsSkipped,
          fileArtifactsMissing: implResult.status === 'ok' ? checkOutputTargets(outputTargets) : undefined,
        }, verification);
        return __recordOnce(terminal);
      }

      const effectiveImplReport = implReport ?? buildFallbackImplReport(implResult);
      const earlyFileArtifactsMissing = implResult.status === 'ok' ? checkOutputTargets(outputTargets) : undefined;
      const earlyStatus: RunStatus =
        implResult.status === 'ok' && earlyFileArtifactsMissing
          ? 'incomplete'
          : implResult.status;
      return {
        ...implResult,
        status: earlyStatus,
        workerStatus,
        specReviewStatus: 'not_applicable',
        qualityReviewStatus: 'not_applicable',
        specReviewReason: 'task produced no file artifacts to review',
        qualityReviewReason: 'task produced no file artifacts to review',
        implementationReport: effectiveImplReport,
        structuredReport: {
          summary: '[No artifacts] task produced no file artifacts to review',
          filesChanged: effectiveImplReport.filesChanged,
          validationsRun: effectiveImplReport.validationsRun,
          deviationsFromBrief: effectiveImplReport.deviationsFromBrief,
          unresolved: effectiveImplReport.unresolved,
          extraSections: effectiveImplReport.extraSections ?? {},
        },
        filePathsSkipped,
        agents: agentEnvelope('not_applicable', 'not_applicable'),
        models: {
          implementer: implModel,
          specReviewer: null,
          qualityReviewer: null,
        },
        fileArtifactsMissing: earlyFileArtifactsMissing,
        commits,
        commitError,
        verification,
        stageStats: stats,
      };
    }

    if (workerStatus === 'needs_context' || workerStatus === 'blocked') {
      return {
        ...implResult,
        workerStatus,
        specReviewStatus: 'skipped',
        qualityReviewStatus: 'skipped',
        specReviewReason: 'skipped: worker reported ' + workerStatus,
        qualityReviewReason: 'skipped: worker reported ' + workerStatus,
        agents: agentEnvelope('skipped', 'skipped'),
        models: {
          implementer: implModel,
          specReviewer: null,
          qualityReviewer: null,
        },
        fileArtifactsMissing: implResult.status === 'ok' ? checkOutputTargets(outputTargets) : undefined,
        commits,
        commitError,
        verification,
        stageStats: stats,
      };
    }

    if (reviewPolicy === 'none') {
      transitionStage('verifying', 'terminal', null, {});
      const terminal = resolveOffTerminal({
        ...implResult,
        workerStatus,
        specReviewStatus: 'skipped',
        qualityReviewStatus: 'skipped',
        specReviewReason: 'skipped: reviewPolicy is none',
        qualityReviewReason: 'skipped: reviewPolicy is none',
        agents: agentEnvelope('skipped', 'skipped'),
        models: {
          implementer: implModel,
          specReviewer: null,
          qualityReviewer: null,
        },
        implementationReport: implReport,
        fileArtifactsMissing: implResult.status === 'ok' ? checkOutputTargets(outputTargets) : undefined,
      }, verification);
      return __recordOnce(terminal);
    }

    const reviewModel = providerFor(pickReviewer({ loop: 'spec', attemptIndex: 0, baseTier: resolved.slot }))?.config.model ?? null;

    const packet = {
      prompt: task.prompt,
      scope: task.filePaths ?? [],
      doneCondition: task.done ?? 'tsc passes',
    };

    let fileContents = await readImplementerFileContents(implResult.filesWritten, task.cwd);

    const effectiveImplReport = implReport ?? buildFallbackImplReport(implResult);

    const evidence = (isArtifactProducing && reviewPolicy !== 'quality_only')
      ? await buildEvidence({ cwd, baselineHead, commits, verification, reviewPolicy })
      : { block: '', diffTruncated: false, fullDiff: '' };

    if (reviewPolicy === 'diff_only') {
      const diffUnavailable: UnavailableMap = new Map();
      const diffReviewerTier = pickReviewer({ loop: 'spec', attemptIndex: 0, baseTier: resolved.slot });
      transitionStage('verifying', 'diff_review', { stage: 'diff_review', stageIndex: 2, reviewRound: 1, attemptCap: 1 }, {});
      const diffReviewT0 = Date.now();
    const diffReviewC0 = runningCostUSD();
      const diffReviewT0_commit = Date.now();
    const diffReviewC0_commit = runningCostUSD();
    const diffCall = await runWithFallback<DiffReviewOrSkipped>({
        assigned: diffReviewerTier,
        providerFor,
        unavailableTiers: diffUnavailable,
        isTransportFailure: (r) => isReviewTransportFailure(r),
        getStatus: (r) => (r as { status?: RunStatus }).status,
        makeSyntheticFailure: () => makeSkippedReviewResult('all_tiers_unavailable'),
        forbiddenTiers: [resolved.slot],
        call: (provider) => runAccounted(provider, () => runDiffReview({ cwd, diff: evidence.fullDiff, diffTruncated: evidence.diffTruncated, verification, worker: { call: (prompt: string, opts?: { cwd?: string; abortSignal?: AbortSignal; timeoutMs?: number }) => provider.run(prompt, { cwd: opts?.cwd ?? cwd, abortSignal: opts?.abortSignal, timeoutMs: opts?.timeoutMs }) }, taskDeadlineMs, abortSignal: stallController.signal })),
      });
      if (diffCall.fallbackFired) {
        emitFallback({ batchId: heartbeatWiring?.batchId ?? '', taskIndex, loop: 'diff', attempt: 0, role: 'diffReviewer', assignedTier: diffReviewerTier, usedTier: diffCall.usedTier as AgentType, reason: diffCall.fallbackReason!, triggeringStatus: diffCall.fallbackTriggeringStatus, violatesSeparation: diffCall.usedTier === implementerHistory[implementerHistory.length - 1], fallbackSeparationRespected: diffCall.fallbackSeparationRespected, assignedIdentity: diffCall.assignedIdentity ?? null, usedIdentity: diffCall.usedIdentity ?? null });
        fallbackOverrides.push({ role: 'diffReviewer', loop: 'diff', attempt: 0, assigned: diffReviewerTier, used: diffCall.usedTier, reason: diffCall.fallbackReason!, triggeringStatus: diffCall.fallbackTriggeringStatus, bothUnavailable: diffCall.bothUnavailable });
      }
      if (diffCall.bothUnavailable) {
        emitFallbackUnavailable({ batchId: heartbeatWiring?.batchId ?? '', taskIndex, loop: 'diff', attempt: 0, role: 'diffReviewer', assignedTier: diffReviewerTier, reason: diffCall.unavailableReason! });
        if (diffCall.unavailableReason === 'reviewer_separation_unsatisfiable') {
          return __recordOnce(adaptForAllTiersUnavailable({ ...implResult, errorCode: 'reviewer_separation_unsatisfiable', diffReviewStatus: 'error' }, 'spec', 0, resolvedModel, implResult, diffCall.unavailableReason));
        }
      }
      const verdict: DiffReviewOrSkipped = diffCall.bothUnavailable ? makeSkippedReviewResult('all_tiers_unavailable') : diffCall.result;
      const diffEnvelopeStatus: RunResult['diffReviewStatus'] =
        'kind' in verdict
          ? (verdict.kind === 'approve' ? 'approved'
            : verdict.kind === 'concerns' ? 'approved'
            : verdict.kind === 'reject' ? 'changes_required'
            : 'error')
          : 'skipped';
      emitTaskEvent('review_decision', {
        stage: 'diff_review',
        verdict: 'kind' in verdict
          ? (verdict.kind === 'approve' ? 'approved'
            : verdict.kind === 'concerns' ? 'concerns'
            : verdict.kind === 'reject' ? 'changes_required'
            : 'error') // verdict.kind === 'transport_failure'
          : 'skipped',
        round: 1,
      });
      endReviewStage(stats, 'diff_review', diffReviewT0_commit, diffReviewC0_commit, reviewerAgentInfoFor((diffCall.usedTier ?? diffReviewerTier) as AgentType), runningCostUSD(), snapshotIdle(stageIdle),
        // Diff review uses 'approve' | 'concerns' | 'reject' | 'transport_failure' (DiffReviewVerdict),
        // distinct from spec/quality verdicts. Map to the telemetry verdict enum here.
        'kind' in verdict
          ? (verdict.kind === 'approve' ? 'approved'
            : verdict.kind === 'concerns' ? 'approved'
            : verdict.kind === 'reject' ? 'changes_required'
            : 'error')
          : 'skipped',
        0);
      return __recordOnce(resolveDiffOnlyTerminal({
        ...implResult,
        workerStatus,
        specReviewStatus: 'skipped',
        qualityReviewStatus: 'skipped',
        specReviewReason: 'skipped: reviewPolicy is diff_only',
        qualityReviewReason: 'skipped: reviewPolicy is diff_only',
        diffReviewStatus: diffEnvelopeStatus,
        implementationReport: effectiveImplReport,
        fileArtifactsMissing: implResult.status === 'ok' ? checkOutputTargets(outputTargets) : undefined,
        agents: agentEnvelope('skipped', 'skipped'),
        models: { implementer: implModel, specReviewer: reviewModel, qualityReviewer: null },
      }, verdict, verification, evidence.diffTruncated));
    }

    let finalImplResult = implResult;
    let finalImplReport = effectiveImplReport;
    let specResult: import('../review/spec-reviewer.js').SpecReviewOrSkipped;
    let specReport: typeof effectiveImplReport | undefined;
    let specReviewReason: string | undefined;

    if (reviewPolicy !== 'quality_only') {
    transitionStage('verifying', 'spec_review', { stage: 'spec_review', stageIndex: 2, reviewRound: 1, attemptCap: maxSpecRows }, null);
    const initialReviewerTier = pickReviewer({ loop: 'spec', attemptIndex: 0, baseTier: resolved.slot });
    specReviewT0 = Date.now();
    specReviewC0 = runningCostUSD();
    const initialSpecReviewIterStart = Date.now();
    const initialSpecReview = await runWithFallback<import('../review/spec-reviewer.js').SpecReviewOrSkipped>({
      assigned: initialReviewerTier,
      providerFor,
      unavailableTiers: specUnavailable,
      isTransportFailure: (r) => isReviewTransportFailure(r),
      getStatus: (r) => (r as { status?: RunStatus }).status,
      makeSyntheticFailure: () => makeSkippedReviewResult('all_tiers_unavailable'),
      forbiddenTiers: [resolved.slot],
      call: (provider) => runAccounted(provider, () => runSpecReview(provider, packet, effectiveImplReport, fileContents, implResult.toolCalls, task.planContext, evidence.block, taskDeadlineMs, stallController.signal, wrappedOnProgress, cwd)),
    });
    specReviewDurationMs += Date.now() - initialSpecReviewIterStart;
    if (initialSpecReview.bothUnavailable) {
      emitFallbackUnavailable({ batchId: heartbeatWiring?.batchId ?? '', taskIndex, loop: 'spec', attempt: 0, role: 'specReviewer', assignedTier: initialReviewerTier, reason: initialSpecReview.unavailableReason! });
      fallbackOverrides.push({ role: 'specReviewer', loop: 'spec', attempt: 0, assigned: initialReviewerTier, used: initialSpecReview.usedTier, reason: initialSpecReview.unavailableReason!, triggeringStatus: initialSpecReview.fallbackTriggeringStatus, bothUnavailable: true });
      specReviewerHistory.push('skipped');
      if (initialSpecReview.unavailableReason === 'reviewer_separation_unsatisfiable') {
        const unavailableBase = {
          ...implResult,
          specReviewStatus: 'error' as const,
          specReviewReason: 'reviewer separation unsatisfiable',
          errorCode: 'reviewer_separation_unsatisfiable',
        };
        return __recordOnce(adaptForAllTiersUnavailable(unavailableBase, 'spec', 0, resolvedModel, implResult, initialSpecReview.unavailableReason));
      }
    } else {
      specReviewerHistory.push(initialSpecReview.usedTier as AgentType);
      if (initialSpecReview.fallbackFired) {
        emitFallback({ batchId: heartbeatWiring?.batchId ?? '', taskIndex, loop: 'spec', attempt: 0, role: 'specReviewer', assignedTier: initialReviewerTier, usedTier: initialSpecReview.usedTier as AgentType, reason: initialSpecReview.fallbackReason!, triggeringStatus: initialSpecReview.fallbackTriggeringStatus, violatesSeparation: initialSpecReview.usedTier === implementerHistory[implementerHistory.length - 1], fallbackSeparationRespected: initialSpecReview.fallbackSeparationRespected, assignedIdentity: initialSpecReview.assignedIdentity ?? null, usedIdentity: initialSpecReview.usedIdentity ?? null });
        fallbackOverrides.push({ role: 'specReviewer', loop: 'spec', attempt: 0, assigned: initialReviewerTier, used: initialSpecReview.usedTier, reason: initialSpecReview.fallbackReason!, triggeringStatus: initialSpecReview.fallbackTriggeringStatus, bothUnavailable: false });
      }
    }
    specResult = initialSpecReview.bothUnavailable
      ? makeSkippedReviewResult('all_tiers_unavailable')
      : initialSpecReview.result;
    specStatus = specResult.status;
    specReport = 'report' in specResult ? specResult.report : undefined;
    specReviewReason = specStatus === 'skipped' ? 'all_tiers_unavailable' : ('errorReason' in specResult ? specResult.errorReason : undefined);
    let prevSpecFindings = [...(specResult.findings ?? [])];
    const specReworkAcc = emptyReworkAcc();

    while (specStatus === 'changes_required') {
      if (specAttemptIndex >= maxSpecRows) return abortReviewLoop(finalImplResult, 'round_cap', 'review round cap reached before spec rework', 'spec');
      const currentCostUSD = taskCostUSD();
      if (currentCostUSD !== null && maxCostUSD !== undefined && currentCostUSD >= 0.8 * maxCostUSD) {
        emitTaskEvent('cost_check', { stage: 'spec_rework', tripped: true, cost_used_usd: currentCostUSD, cost_cap_usd: maxCostUSD, cost_available: true });
        return abortReviewLoop(finalImplResult, 'cost_ceiling', 'cost ceiling reached before spec rework', 'spec');
      }
      const wallClock = Date.now() - taskStartMs;
      if (wallClock >= MAX_TIME_PRESTOP_RATIO * taskTimeoutMs) {
        emitTaskEvent('time_check', { stage: 'spec_rework', tripped: true, wallClockMs: wallClock, timeoutMs: taskTimeoutMs });
        return abortReviewLoop(finalImplResult, 'time_ceiling', `time ceiling reached before spec rework (${wallClock}ms >= 0.8 × ${taskTimeoutMs}ms)`, 'spec', wallClock);
      }
      const decision = pickEscalation({ loop: 'spec', attemptIndex: specAttemptIndex, baseTier: resolved.slot });
      if (decision.isEscalated) emitEscalationEvent('spec', specAttemptIndex, decision);
      const specReworkIterStart = Date.now();
      transitionStage('spec_review', 'spec_rework', { stage: 'spec_rework', stageIndex: 3, reviewRound: specAttemptIndex, attemptCap: maxSpecRows }, { attempt: specAttemptIndex, attemptCap: maxSpecRows, implTier: decision.impl, reviewerTier: decision.reviewer, escalated: decision.isEscalated });
      const feedback = specResult.findings.length > 0 ? `\n\n## Spec Review Feedback (round ${specAttemptIndex}):\n${specResult.findings.map(f => `- ${f}`).join('\n')}` : '';
      const reworkTask = withDoneCondition({ ...task, prompt: `${task.prompt}${feedback}` });
      const reworkCall = await runWithFallback<RunResult>({ assigned: decision.impl, providerFor, unavailableTiers: specUnavailable, isTransportFailure: (r) => TRANSPORT_FAILURES.has(r.status) && r.capExhausted === undefined, getStatus: (r) => r.status, makeSyntheticFailure: (assigned) => makeSyntheticRunResult(assigned, 'all_tiers_unavailable'), call: (provider) => runAccounted(provider, () => delegateWithEscalation(reworkTask, [provider], { explicitlyPinned: true, onProgress: wrappedOnProgress, taskDeadlineMs, abortSignal: stallController.signal, assignedTier: decision.impl })) });
      if (reworkCall.fallbackFired || reworkCall.bothUnavailable) fallbackOverrides.push({ role: 'implementer', loop: 'spec', attempt: specAttemptIndex, assigned: decision.impl, used: reworkCall.usedTier, reason: (reworkCall.fallbackReason ?? reworkCall.unavailableReason)!, triggeringStatus: reworkCall.fallbackTriggeringStatus, bothUnavailable: reworkCall.bothUnavailable });
      if (reworkCall.fallbackFired) {
        emitFallback({ batchId: heartbeatWiring?.batchId ?? '', taskIndex, loop: 'spec', attempt: specAttemptIndex, role: 'implementer', assignedTier: decision.impl, usedTier: reworkCall.usedTier as AgentType, reason: reworkCall.fallbackReason!, triggeringStatus: reworkCall.fallbackTriggeringStatus, violatesSeparation: false });
        if (decision.isEscalated && reworkCall.fallbackReason === 'not_configured') emitEscalationUnavailable({ batchId: heartbeatWiring?.batchId ?? '', taskIndex, loop: 'spec', attempt: specAttemptIndex, role: 'implementer', wantedTier: decision.impl, reason: reworkCall.fallbackReason });
      }
      if (reworkCall.bothUnavailable) {
        emitFallbackUnavailable({ batchId: heartbeatWiring?.batchId ?? '', taskIndex, loop: 'spec', attempt: specAttemptIndex, role: 'implementer', assignedTier: decision.impl, reason: reworkCall.unavailableReason! });
        if (decision.isEscalated) emitEscalationUnavailable({ batchId: heartbeatWiring?.batchId ?? '', taskIndex, loop: 'spec', attempt: specAttemptIndex, role: 'implementer', wantedTier: decision.impl, reason: reworkCall.unavailableReason! });
        return __recordOnce(adaptForAllTiersUnavailable(reworkCall.result, 'spec', specAttemptIndex, resolvedModel, reworkCall.salvageResult, reworkCall.unavailableReason));
      }
      finalImplResult = reworkCall.result;
      latestAttemptedImpl = { tier: reworkCall.usedTier as AgentType, result: finalImplResult };
      implementerHistory.push(reworkCall.usedTier as AgentType);
      const reworkReport = parseStructuredReport(finalImplResult.output);
      finalImplReport = reworkReport.summary ? reworkReport : buildFallbackImplReport(finalImplResult);
      fileContents = await readImplementerFileContents(finalImplResult.filesWritten, task.cwd);
      accumulateReworkIteration(specReworkAcc, finalImplResult, Date.now() - specReworkIterStart, snapshotIdle(stageIdle));
      commitReworkStage(stats, 'spec_rework', specReworkAcc, implementerAgentInfo);
      transitionStage('spec_rework', 'spec_review', { stage: 'spec_review', stageIndex: 2, reviewRound: specAttemptIndex + 1, attemptCap: maxSpecRows }, null);
      const reReviewIterStart = Date.now();
      const reviewCall = await runWithFallback<import('../review/spec-reviewer.js').SpecReviewOrSkipped>({ assigned: decision.reviewer, providerFor, unavailableTiers: specUnavailable, isTransportFailure: (r) => isReviewTransportFailure(r), getStatus: (r) => (r as { status?: RunStatus }).status, makeSyntheticFailure: () => makeSkippedReviewResult('all_tiers_unavailable'), forbiddenTiers: [resolved.slot], call: (provider) => runAccounted(provider, () => runSpecReview(provider, packet, finalImplReport, fileContents, finalImplResult.toolCalls, task.planContext, evidence.block, taskDeadlineMs, stallController.signal, wrappedOnProgress, cwd)) });
      specReviewDurationMs += Date.now() - reReviewIterStart;
      if (reviewCall.bothUnavailable) {
        emitFallbackUnavailable({ batchId: heartbeatWiring?.batchId ?? '', taskIndex, loop: 'spec', attempt: specAttemptIndex, role: 'specReviewer', assignedTier: decision.reviewer, reason: reviewCall.unavailableReason! });
        fallbackOverrides.push({ role: 'specReviewer', loop: 'spec', attempt: specAttemptIndex, assigned: decision.reviewer, used: reviewCall.usedTier, reason: reviewCall.unavailableReason!, triggeringStatus: reviewCall.fallbackTriggeringStatus, bothUnavailable: true });
        specReviewerHistory.push('skipped');
        if (reviewCall.unavailableReason === 'reviewer_separation_unsatisfiable') {
          const unavailableBase = {
            ...finalImplResult,
            specReviewStatus: 'error' as const,
            specReviewReason: 'reviewer separation unsatisfiable',
            errorCode: 'reviewer_separation_unsatisfiable',
          };
          return __recordOnce(adaptForAllTiersUnavailable(unavailableBase, 'spec', specAttemptIndex, resolvedModel, finalImplResult, reviewCall.unavailableReason));
        }
      } else {
        specReviewerHistory.push(reviewCall.usedTier as AgentType);
        if (reviewCall.fallbackFired) {
          emitFallback({ batchId: heartbeatWiring?.batchId ?? '', taskIndex, loop: 'spec', attempt: specAttemptIndex, role: 'specReviewer', assignedTier: decision.reviewer, usedTier: reviewCall.usedTier as AgentType, reason: reviewCall.fallbackReason!, triggeringStatus: reviewCall.fallbackTriggeringStatus, violatesSeparation: reviewCall.usedTier === implementerHistory[implementerHistory.length - 1], fallbackSeparationRespected: reviewCall.fallbackSeparationRespected, assignedIdentity: reviewCall.assignedIdentity ?? null, usedIdentity: reviewCall.usedIdentity ?? null });
          fallbackOverrides.push({ role: 'specReviewer', loop: 'spec', attempt: specAttemptIndex, assigned: decision.reviewer, used: reviewCall.usedTier, reason: reviewCall.fallbackReason!, triggeringStatus: reviewCall.fallbackTriggeringStatus, bothUnavailable: false });
        }
      }
      specResult = reviewCall.result;
      specStatus = specResult.status;
      specReport = 'report' in specResult ? specResult.report : undefined;
      specReviewReason = specStatus === 'skipped' ? 'all_tiers_unavailable' : ('errorReason' in specResult ? specResult.errorReason : undefined);
      if (reviewDidNotReject(specStatus)) lastNonRejectedImpl = { tier: implementerHistory[implementerHistory.length - 1]!, result: finalImplResult };
      specAttemptIndex++;
      if (specStatus === 'approved' || specStatus === 'skipped') break;
      const currentFindings = [...(specResult.findings ?? [])].sort().join('\0');
      const prevFindings = [...prevSpecFindings].sort().join('\0');
      if (currentFindings === prevFindings && currentFindings !== '') break;
      prevSpecFindings = [...(specResult.findings ?? [])];
    }
    } else {
      specResult = { status: 'skipped', report: undefined, findings: [], reason: 'all_tiers_unavailable' };
      specStatus = 'not_applicable';
      specReport = undefined;
      specReviewReason = 'skipped: reviewPolicy is quality_only';
    }

    if (reviewPolicy === 'full' || reviewPolicy === 'quality_only') {
      qualityUnavailable = new Map();
      const qualityReviewerTier = pickReviewer({ loop: 'quality', attemptIndex: 0, baseTier: resolved.slot });
      transitionStage(currentStage, 'quality_review', { stage: 'quality_review', stageIndex: 4, reviewRound: 1, attemptCap: maxQualityRows }, null);
      qualityReviewT0 = Date.now();
      qualityReviewC0 = runningCostUSD();
      const initialQualityIterStart = Date.now();
      const initialQuality = await runWithFallback<LegacyQualityReviewResult>({ assigned: qualityReviewerTier, providerFor, unavailableTiers: qualityUnavailable, isTransportFailure: (r) => isReviewTransportFailure(r), getStatus: (r) => (r as { status?: RunStatus }).status, makeSyntheticFailure: () => makeSkippedReviewResult('all_tiers_unavailable'), forbiddenTiers: [resolved.slot], call: (provider) => runAccounted(provider, () => runQualityReview(provider, packet, specReport ?? finalImplReport, fileContents, finalImplResult.toolCalls, finalImplResult.filesWritten, evidence.block, qualityReviewPromptBuilder, finalImplResult.output, taskDeadlineMs, stallController.signal, wrappedOnProgress, cwd)) });
      qualityReviewDurationMs += Date.now() - initialQualityIterStart;
      if (initialQuality.bothUnavailable) {
        emitFallbackUnavailable({ batchId: heartbeatWiring?.batchId ?? '', taskIndex, loop: 'quality', attempt: 0, role: 'qualityReviewer', assignedTier: qualityReviewerTier, reason: initialQuality.unavailableReason! });
        fallbackOverrides.push({ role: 'qualityReviewer', loop: 'quality', attempt: 0, assigned: qualityReviewerTier, used: initialQuality.usedTier, reason: initialQuality.unavailableReason!, triggeringStatus: initialQuality.fallbackTriggeringStatus, bothUnavailable: true });
        qualityReviewerHistory.push('skipped');
        if (initialQuality.unavailableReason === 'reviewer_separation_unsatisfiable') {
          const unavailableBase = {
            ...finalImplResult,
            qualityReviewStatus: 'error' as const,
            qualityReviewReason: 'reviewer separation unsatisfiable',
            errorCode: 'reviewer_separation_unsatisfiable',
          };
          return __recordOnce(adaptForAllTiersUnavailable(unavailableBase, 'quality', 0, resolvedModel, finalImplResult, initialQuality.unavailableReason));
        }
      } else {
        qualityReviewerHistory.push(initialQuality.usedTier as AgentType);
        if (initialQuality.fallbackFired) {
          emitFallback({ batchId: heartbeatWiring?.batchId ?? '', taskIndex, loop: 'quality', attempt: 0, role: 'qualityReviewer', assignedTier: qualityReviewerTier, usedTier: initialQuality.usedTier as AgentType, reason: initialQuality.fallbackReason!, triggeringStatus: initialQuality.fallbackTriggeringStatus, violatesSeparation: initialQuality.usedTier === implementerHistory[implementerHistory.length - 1], fallbackSeparationRespected: initialQuality.fallbackSeparationRespected, assignedIdentity: initialQuality.assignedIdentity ?? null, usedIdentity: initialQuality.usedIdentity ?? null });
          fallbackOverrides.push({ role: 'qualityReviewer', loop: 'quality', attempt: 0, assigned: qualityReviewerTier, used: initialQuality.usedTier, reason: initialQuality.fallbackReason!, triggeringStatus: initialQuality.fallbackTriggeringStatus, bothUnavailable: false });
        }
      }
      qualityResult = initialQuality.result;
      qualityAttemptIndex = 1;
      if (reviewDidNotReject(qualityResult.status)) lastNonRejectedImpl = { tier: implementerHistory[implementerHistory.length - 1]!, result: finalImplResult };

      if (reviewPolicy === 'quality_only') {
        // Annotation model: emit one quality event per pass with severity-correction
        // and mean-confidence summary fields. Then we are done — no rework loop.
        const annotated = qualityResult.annotatedFindings ?? [];
        // meanConfidence skips null entries (fallback path); null when ALL are null.
        const numericConfidences = annotated
          .map(f => f.annotatorConfidence)
          .filter((c): c is number => c !== null);
        const meanConfidence = numericConfidences.length > 0
          ? Math.round((numericConfidences.reduce((s, c) => s + c, 0) / numericConfidences.length) * 100) / 100
          : null;

        // STEP A: Funnel annotated findings into concerns[] so V3
        // findingsBySeverity (built later in event-builder.ts:buildReviewStage)
        // rolls them up. MUST happen before any path that records the task,
        // and before emitTaskEvent below since downstream consumers may
        // observe finalImplResult during emit.
        if (annotated.length > 0) {
          const findingsAsConcerns = annotated.map((f) => ({
            source: 'quality_review' as const,
            severity: f.severity as 'critical' | 'high' | 'medium' | 'low',
            message: `[${f.id}] ${f.claim}`,
          }));
          finalImplResult = {
            ...finalImplResult,
            concerns: [...(finalImplResult.concerns ?? []), ...findingsAsConcerns],
            annotatedFindings: annotated,
          };
        }

        // STEP B: Emit per-pass annotation event (no rework loop in quality_only).
        emitTaskEvent('read_only_review.quality', {
          route: routeKey,
          verdict: qualityResult.status === 'annotated' ? 'annotated'
            : qualityResult.status === 'skipped' ? 'skipped'
            : 'error',
          iterationIndex: 1,
          findingsReviewed: annotated.length,
          meanConfidence,
          durationMs: Date.now() - qualityReviewT0,
          costUSD: runningCostUSD() !== null && qualityReviewC0 !== null ? runningCostUSD()! - qualityReviewC0! : null,
        });
      } else {
        // Artifact-route gating model — keep the rework loop.
        let prevQualityFindings = [...(qualityResult.findings ?? [])];
        const qualityReworkAcc = emptyReworkAcc();
        while (qualityResult.status === 'changes_required') {
          if (qualityAttemptIndex >= maxQualityRows) return abortReviewLoop(finalImplResult, 'round_cap', 'review round cap reached before quality rework', 'quality');
          const currentCostUSD = taskCostUSD();
          if (currentCostUSD !== null && maxCostUSD !== undefined && currentCostUSD >= 0.8 * maxCostUSD) {
            emitTaskEvent('cost_check', { stage: 'quality_rework', tripped: true, cost_used_usd: currentCostUSD, cost_cap_usd: maxCostUSD, cost_available: true });
            return abortReviewLoop(finalImplResult, 'cost_ceiling', 'cost ceiling reached before quality rework', 'quality');
          }
          const wallClock = Date.now() - taskStartMs;
          if (wallClock >= MAX_TIME_PRESTOP_RATIO * taskTimeoutMs) {
            emitTaskEvent('time_check', { stage: 'quality_rework', tripped: true, wallClockMs: wallClock, timeoutMs: taskTimeoutMs });
            return abortReviewLoop(finalImplResult, 'time_ceiling', `time ceiling reached before quality rework (${wallClock}ms >= 0.8 × ${taskTimeoutMs}ms)`, 'quality', wallClock);
          }
          const decision = pickEscalation({ loop: 'quality', attemptIndex: qualityAttemptIndex, baseTier: resolved.slot });
          if (decision.isEscalated) emitEscalationEvent('quality', qualityAttemptIndex, decision);
          const qualityReworkIterStart = Date.now();
          transitionStage('quality_review', 'quality_rework', { stage: 'quality_rework', stageIndex: 5, reviewRound: qualityAttemptIndex, attemptCap: maxQualityRows }, { attempt: qualityAttemptIndex, attemptCap: maxQualityRows, implTier: decision.impl, reviewerTier: decision.reviewer, escalated: decision.isEscalated });
          const feedback = qualityResult.findings.length > 0 ? `\n\n## Quality Review Feedback (round ${qualityAttemptIndex}):\n${qualityResult.findings.map(f => `- ${f}`).join('\n')}` : '';
          const reworkTask = withDoneCondition({ ...task, prompt: `${task.prompt}${feedback}` });
          const reworkCall = await runWithFallback<RunResult>({ assigned: decision.impl, providerFor, unavailableTiers: qualityUnavailable, isTransportFailure: (r) => TRANSPORT_FAILURES.has(r.status) && r.capExhausted === undefined, getStatus: (r) => r.status, makeSyntheticFailure: (assigned) => makeSyntheticRunResult(assigned, 'all_tiers_unavailable'), call: (provider) => runAccounted(provider, () => delegateWithEscalation(reworkTask, [provider], { explicitlyPinned: true, onProgress: wrappedOnProgress, taskDeadlineMs, abortSignal: stallController.signal, assignedTier: decision.impl })) });
          if (reworkCall.fallbackFired || reworkCall.bothUnavailable) fallbackOverrides.push({ role: 'implementer', loop: 'quality', attempt: qualityAttemptIndex, assigned: decision.impl, used: reworkCall.usedTier, reason: (reworkCall.fallbackReason ?? reworkCall.unavailableReason)!, triggeringStatus: reworkCall.fallbackTriggeringStatus, bothUnavailable: reworkCall.bothUnavailable });
          if (reworkCall.fallbackFired) emitFallback({ batchId: heartbeatWiring?.batchId ?? '', taskIndex, loop: 'quality', attempt: qualityAttemptIndex, role: 'implementer', assignedTier: decision.impl, usedTier: reworkCall.usedTier as AgentType, reason: reworkCall.fallbackReason!, triggeringStatus: reworkCall.fallbackTriggeringStatus, violatesSeparation: false });
          if (reworkCall.bothUnavailable) {
            emitFallbackUnavailable({ batchId: heartbeatWiring?.batchId ?? '', taskIndex, loop: 'quality', attempt: qualityAttemptIndex, role: 'implementer', assignedTier: decision.impl, reason: reworkCall.unavailableReason! });
            if (decision.isEscalated) emitEscalationUnavailable({ batchId: heartbeatWiring?.batchId ?? '', taskIndex, loop: 'quality', attempt: qualityAttemptIndex, role: 'implementer', wantedTier: decision.impl, reason: reworkCall.unavailableReason! });
            return __recordOnce(adaptForAllTiersUnavailable(reworkCall.result, 'quality', qualityAttemptIndex, resolvedModel, reworkCall.salvageResult, reworkCall.unavailableReason));
          }
          finalImplResult = reworkCall.result;
          latestAttemptedImpl = { tier: reworkCall.usedTier as AgentType, result: finalImplResult };
          implementerHistory.push(reworkCall.usedTier as AgentType);
          const reworkReport = parseStructuredReport(finalImplResult.output);
          finalImplReport = reworkReport.summary ? reworkReport : buildFallbackImplReport(finalImplResult);
          fileContents = await readImplementerFileContents(finalImplResult.filesWritten, task.cwd);
          accumulateReworkIteration(qualityReworkAcc, finalImplResult, Date.now() - qualityReworkIterStart, snapshotIdle(stageIdle));
          commitReworkStage(stats, 'quality_rework', qualityReworkAcc, implementerAgentInfo);
          transitionStage('quality_rework', 'quality_review', { stage: 'quality_review', stageIndex: 4, reviewRound: qualityAttemptIndex + 1, attemptCap: maxQualityRows }, null);
          const qReReviewIterStart = Date.now();
          const reviewCall = await runWithFallback<LegacyQualityReviewResult>({ assigned: decision.reviewer, providerFor, unavailableTiers: qualityUnavailable, isTransportFailure: (r) => isReviewTransportFailure(r), getStatus: (r) => (r as { status?: RunStatus }).status, makeSyntheticFailure: () => makeSkippedReviewResult('all_tiers_unavailable'), forbiddenTiers: [resolved.slot], call: (provider) => runAccounted(provider, () => runQualityReview(provider, packet, finalImplReport, fileContents, finalImplResult.toolCalls, finalImplResult.filesWritten, evidence.block, qualityReviewPromptBuilder, finalImplResult.output, taskDeadlineMs, stallController.signal, wrappedOnProgress, cwd)) });
          qualityReviewDurationMs += Date.now() - qReReviewIterStart;
          if (reviewCall.bothUnavailable) {
            emitFallbackUnavailable({ batchId: heartbeatWiring?.batchId ?? '', taskIndex, loop: 'quality', attempt: qualityAttemptIndex, role: 'qualityReviewer', assignedTier: decision.reviewer, reason: reviewCall.unavailableReason! });
            fallbackOverrides.push({ role: 'qualityReviewer', loop: 'quality', attempt: qualityAttemptIndex, assigned: decision.reviewer, used: reviewCall.usedTier, reason: reviewCall.unavailableReason!, triggeringStatus: reviewCall.fallbackTriggeringStatus, bothUnavailable: true });
            qualityReviewerHistory.push('skipped');
            if (reviewCall.unavailableReason === 'reviewer_separation_unsatisfiable') {
              const unavailableBase = {
                ...finalImplResult,
                qualityReviewStatus: 'error' as const,
                qualityReviewReason: 'reviewer separation unsatisfiable',
                errorCode: 'reviewer_separation_unsatisfiable',
              };
              return __recordOnce(adaptForAllTiersUnavailable(unavailableBase, 'quality', qualityAttemptIndex, resolvedModel, finalImplResult, reviewCall.unavailableReason));
            }
          } else {
            qualityReviewerHistory.push(reviewCall.usedTier as AgentType);
            if (reviewCall.fallbackFired) {
              emitFallback({ batchId: heartbeatWiring?.batchId ?? '', taskIndex, loop: 'quality', attempt: qualityAttemptIndex, role: 'qualityReviewer', assignedTier: decision.reviewer, usedTier: reviewCall.usedTier as AgentType, reason: reviewCall.fallbackReason!, triggeringStatus: reviewCall.fallbackTriggeringStatus, violatesSeparation: reviewCall.usedTier === implementerHistory[implementerHistory.length - 1], fallbackSeparationRespected: reviewCall.fallbackSeparationRespected, assignedIdentity: reviewCall.assignedIdentity ?? null, usedIdentity: reviewCall.usedIdentity ?? null });
              fallbackOverrides.push({ role: 'qualityReviewer', loop: 'quality', attempt: qualityAttemptIndex, assigned: decision.reviewer, used: reviewCall.usedTier, reason: reviewCall.fallbackReason!, triggeringStatus: reviewCall.fallbackTriggeringStatus, bothUnavailable: false });
            }
          }
          qualityResult = reviewCall.result;
          if (reviewDidNotReject(qualityResult.status)) lastNonRejectedImpl = { tier: implementerHistory[implementerHistory.length - 1]!, result: finalImplResult };
          qualityAttemptIndex++;
          if (qualityResult.status === 'approved' || qualityResult.status === 'skipped') break;
          const currentFindings = [...(qualityResult.findings ?? [])].sort().join('\0');
          const prevFindings = [...prevQualityFindings].sort().join('\0');
          if (currentFindings === prevFindings && currentFindings !== '') break;
          prevQualityFindings = [...(qualityResult.findings ?? [])];
        }
      }
    }

    const finalReport = specReport ?? finalImplReport;

    const concerns = [...(finalImplResult.concerns ?? [])];
    let finalWorkerStatus = workerStatus;
    if (verification.status === 'failed') {
      concerns.push({
        source: 'verification',
        severity: 'high',
        message: 'Verification failed after implementation.',
      });
      if (finalWorkerStatus === 'done') finalWorkerStatus = 'done_with_concerns';
    }
    if (evidence.diffTruncated) {
      concerns.push({
        source: 'diff_truncated',
        severity: 'medium',
        message: 'Implementation diff exceeded the reviewer evidence byte cap and was truncated.',
      });
    }

    const specAggregateStatus = reviewPolicy === 'quality_only'
      ? 'skipped' as const
      : (['approved', 'changes_required', 'skipped', 'error', 'api_error', 'network_error', 'timeout'].includes(specStatus) ? specStatus : 'error') as 'approved' | 'changes_required' | 'skipped' | 'error' | 'api_error' | 'network_error' | 'timeout';

    // R3 invariant: review-stage entries must record the actual REVIEWER's
    // model, not the implementer's. The last-used reviewer tier is the one
    // that produced the final verdict (after any escalation during rework).
    // Fall back to the implementer's tier only when no reviewer ever ran
    // (skipped path), which is fine because the schema R3 then doesn't apply.
    const lastSpecReviewerEntry = specReviewerHistory[specReviewerHistory.length - 1];
    const lastQualityReviewerEntry = qualityReviewerHistory[qualityReviewerHistory.length - 1];
    const specReviewAgent = lastSpecReviewerEntry === undefined || lastSpecReviewerEntry === 'skipped'
      ? implementerAgentInfo
      : reviewerAgentInfoFor(lastSpecReviewerEntry);
    const qualityReviewAgent = lastQualityReviewerEntry === undefined || lastQualityReviewerEntry === 'skipped'
      ? implementerAgentInfo
      : reviewerAgentInfoFor(lastQualityReviewerEntry);

    // Merge accumulated review-stage wall durations into the metrics
    // override. endReviewStage uses the override when present and falls
    // back to `Date.now() - t0` otherwise (which over-counts review-block
    // span across rework + later stages).
    specReviewMetrics = ((specResult as any).metrics ?? {}) as Record<string, unknown>;
    qualityReviewMetrics = ((qualityResult as any).metrics ?? {}) as Record<string, unknown>;

    finalizeSpecReviewStage();
    finalizeQualityReviewStage();
    const qualityAggregateStatus = qualityResult.status as 'approved' | 'changes_required' | 'annotated' | 'skipped' | 'error' | 'api_error' | 'network_error' | 'timeout';
    const aggregated = aggregateResult(
      finalReport,
      specReport,
      qualityResult.report,
      specAggregateStatus,
      qualityAggregateStatus,
    );

    // File artifact verification: check whether output targets exist on disk after all work.
    // Only applies when status is ok; non-ok statuses skip verification entirely.
    const fileArtifactsMissing =
      finalImplResult.status === 'ok' && outputTargets.length > 0
        ? checkOutputTargets(outputTargets)
        : undefined;

    // Status downgrade: review verdicts are authoritative. File artifact verification
    // is also authoritative — missing output targets downgrade ok → incomplete.
    const finalStatus: RunStatus =
      finalImplResult.status === 'ok' &&
      (specStatus === 'changes_required' || qualityResult.status === 'changes_required')
        ? 'incomplete'
        : finalImplResult.status === 'ok' && fileArtifactsMissing
          ? 'incomplete'
          : finalImplResult.status;
    const specEnvelopeStatus = (specStatus === 'api_error' || specStatus === 'network_error' || specStatus === 'timeout' || specStatus === 'api_aborted' ? 'error' : specStatus) as 'approved' | 'changes_required' | 'skipped' | 'error' | 'not_applicable';
    const qualityEnvelopeStatus = qualityResult.status === 'api_error' || qualityResult.status === 'network_error' || qualityResult.status === 'timeout' || qualityResult.status === 'api_aborted' ? 'error' : qualityResult.status;

    const runResult: RunResult = {
      ...finalImplResult,
      status: finalStatus,
      workerStatus: finalWorkerStatus,
      concerns,
      specReviewStatus: specEnvelopeStatus,
      qualityReviewStatus: qualityEnvelopeStatus,
      stageStats: stats,
      reviewRounds: reviewRounds(),
      specReviewReason: 'errorReason' in specResult ? specResult.errorReason : undefined,
      qualityReviewReason: 'errorReason' in qualityResult ? qualityResult.errorReason : undefined,
      structuredReport: aggregated,
      implementationReport: finalImplReport,
      specReviewReport: specReport,
      qualityReviewReport: qualityResult.report,
      filePathsSkipped,
      agents: agentEnvelope(
        specReviewerHistory[specReviewerHistory.length - 1] ?? 'not_applicable',
        qualityReviewerHistory[qualityReviewerHistory.length - 1] ?? ((reviewPolicy === 'full' || reviewPolicy === 'quality_only') ? 'not_applicable' : 'skipped'),
      ),
      models: {
        implementer: implModel,
        specReviewer: reviewPolicy !== 'quality_only' ? reviewModel : null,
        qualityReviewer: (reviewPolicy === 'full' || reviewPolicy === 'quality_only') ? reviewModel : null,
      },
      fileArtifactsMissing,
      commits,
      commitError,
      verification,
    };

    if (reviewPolicy === 'quality_only') {
      emitTaskEvent('read_only_review.terminal', {
        route: routeKey,
        roundsUsed: qualityAttemptIndex,
        finalQualityVerdict: qualityResult.status === 'annotated' ? 'annotated'
          : qualityResult.status === 'skipped' ? 'skipped'
          : 'error',
        costUSD: taskCostUSD(),
        durationMs: Date.now() - taskStartMs,
      });
    }

    return __recordOnce(runResult);
  } catch (err) {
    const errorRunResult = withVerification(workerErrorResult(err));
    if (reviewPolicy === 'quality_only') {
      emitTaskEvent('read_only_review.terminal', {
        route: routeKey,
        roundsUsed: qualityAttemptIndex,
        finalQualityVerdict: 'error',
        costUSD: taskCostUSD(),
        durationMs: Date.now() - taskStartMs,
      });
    }
    return __recordOnce(errorRunResult);
  } finally {
    // Fire telemetry recorder once across every exit path. Bedrock invariant:
    // telemetry failure NEVER throws to the user task.
    if (__finalRunResult !== undefined) {
      try {
        recorder?.recordTaskCompleted({
          route: _route ?? 'delegate',
          taskSpec: task,
          runResult: __finalRunResult,
          client: _client ?? 'claude-code',
          triggeringSkill: _triggeringSkill ?? 'direct',
          parentModel: task.parentModel ?? null,
          reviewPolicy,
          verifyCommandPresent: !!(task.verifyCommand && task.verifyCommand.length > 0),
        });
      } catch { /* silent */ }

      // NEW in v3.9.0: local JSONL emit. Distinct from cloud — local is
      // for verbose/observability consumers; cloud is for telemetry sink.
      try {
        const r = __finalRunResult;
        emitTaskEvent('task_completed', {
          status: r.status,
          workerStatus: r.workerStatus ?? null,
          turns: r.turns,
          durationMs: r.durationMs ?? null,
          filesRead: r.filesRead?.length ?? 0,
          filesWritten: r.filesWritten?.length ?? 0,
          toolCalls: r.toolCalls?.length ?? 0,
          inputTokens: r.usage.inputTokens,
          outputTokens: r.usage.outputTokens,
          cachedTokens: ((r.usage.cachedReadTokens ?? 0) + (r.usage.cachedNonReadTokens ?? 0)) || null,
          reasoningTokens: null,
          costUSD: r.cost?.costUSD,
          taskMaxIdleMs: r.taskMaxIdleMs ?? null,
          stallTriggered: r.stallTriggered ?? false,
          stages_json: diagnostics?.logger?.expectedPath() ?? null,
        });
      } catch { /* silent — never break the user task */ }

      try {
        const summary = computeTaskCompletionSummary({
          runResult: __finalRunResult,
          taskIndexZero: taskIndex,
          totalTasks: 1,
          batchId: heartbeatWiring?.batchId ?? '',
        });
        emitTaskEvent('task_done_summary', {
          message: formatTaskDoneLine(summary),
          status: summary.terminalStatus,
          duration_ms: summary.totalDurationMs,
          cost_usd: summary.totalCostUSD,
          input_tokens: summary.totalInputTokens,
          output_tokens: summary.totalOutputTokens,
          turns: summary.turns,
          files_written: summary.filesWrittenCount,
          spec_verdict: summary.specReviewVerdict,
          quality_verdict: summary.qualityReviewVerdict,
        });
      } catch { /* silent */ }
    }
    transitionStage(currentStage, 'terminal', { stage: 'terminal', stageIndex: 8 }, null);
    heartbeat?.stop();
    clearInterval(stallWatchdogInterval);
  }
}
