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
import { computeCostUSD, computeSavedCostUSD } from '../types.js';
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
} from '../escalation/fallback.js';
import { findModelCapabilities, findModelProfile, extractCanonicalModelName } from '../routing/model-profiles.js';
import { HeartbeatTimer } from '../heartbeat.js';
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
import type {
  FallbackEventParams,
  FallbackUnavailableEventParams,
  EscalationEventParams,
  EscalationUnavailableEventParams,
} from '../diagnostics/disconnect-log.js';
import { withDoneCondition } from './execute-task.js';

const exec = promisify(execFile);

export function emptyStats(): StageStatsMap {
  return {
    implementing:   { stage: 'implementing',   entered: false, durationMs: null, costUSD: null, agentTier: null, modelFamily: null, model: null },
    spec_rework:    { stage: 'spec_rework',    entered: false, durationMs: null, costUSD: null, agentTier: null, modelFamily: null, model: null },
    quality_rework: { stage: 'quality_rework', entered: false, durationMs: null, costUSD: null, agentTier: null, modelFamily: null, model: null },
    committing:     { stage: 'committing',     entered: false, durationMs: null, costUSD: null, agentTier: null, modelFamily: null, model: null },
    verifying:      { stage: 'verifying',      entered: false, durationMs: null, costUSD: null, agentTier: null, modelFamily: null, model: null, outcome: null, skipReason: null },
    spec_review:    { stage: 'spec_review',    entered: false, durationMs: null, costUSD: null, agentTier: null, modelFamily: null, model: null, verdict: null, roundsUsed: null },
    quality_review: { stage: 'quality_review', entered: false, durationMs: null, costUSD: null, agentTier: null, modelFamily: null, model: null, verdict: null, roundsUsed: null },
    diff_review:    { stage: 'diff_review',    entered: false, durationMs: null, costUSD: null, agentTier: null, modelFamily: null, model: null, verdict: null, roundsUsed: null },
  };
}

const FAMILY_MAP: Record<string, string> = {
  claude: "claude",
  gpt: "openai", o1: "openai", o3: "openai", openai: "openai",
  gemini: "gemini",
  deepseek: "deepseek",
};

function modelFamily(model: string): string {
  const canonical = extractCanonicalModelName(model);
  const dash = canonical.indexOf('-');
  const raw = dash > 0 ? canonical.slice(0, dash) : canonical;
  return FAMILY_MAP[raw.toLowerCase()] ?? 'other';
}

export function endBaseStage(
  stats: StageStatsMap,
  name: 'implementing' | 'spec_rework' | 'quality_rework' | 'committing',
  t0: number,
  c0: number | null,
  agent: { tier: 'standard' | 'complex'; model: string },
  finalCostUSD: number | null,
): void {
  // Cast through unknown — TS can't narrow stats[name] on a union-typed index;
  // the runtime invariant (set name's slot to its matching variant) is enforced
  // by the helper signature and tested by tests/run-tasks/stage-stats.test.ts.
  (stats as Record<string, unknown>)[name] = {
    stage: name,
    entered: true,
    durationMs: Date.now() - t0,
    costUSD: finalCostUSD !== null && c0 !== null ? finalCostUSD - c0 : null,
    agentTier: agent.tier,
    modelFamily: modelFamily(agent.model),
    model: agent.model,
  };
}

export function endReviewStage(
  stats: StageStatsMap,
  name: 'spec_review' | 'quality_review' | 'diff_review',
  t0: number,
  c0: number | null,
  agent: { tier: 'standard' | 'complex'; model: string },
  finalCostUSD: number | null,
  verdict: ReviewVerdict,
  roundsUsed: number,
): void {
  (stats as Record<string, unknown>)[name] = {
    stage: name,
    entered: true,
    durationMs: Date.now() - t0,
    costUSD: finalCostUSD !== null && c0 !== null ? finalCostUSD - c0 : null,
    agentTier: agent.tier,
    modelFamily: modelFamily(agent.model),
    model: agent.model,
    verdict,
    roundsUsed,
  };
}

export function endVerifyStage(
  stats: StageStatsMap,
  t0: number,
  c0: number | null,
  agent: { tier: 'standard' | 'complex'; model: string },
  finalCostUSD: number | null,
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
    logger?: import('../diagnostics/disconnect-log.js').DiagnosticLogger;
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
    }) => void;
  },
  _route?: string,
  _client?: string,
  _triggeringSkill?: string,
): Promise<RunResult> {
  const reviewPolicy = task.reviewPolicy ?? 'full';
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

  // Partition filePaths into output targets before the worker runs.
  // Output targets are paths that do not yet exist on disk.
  const { outputTargets } = partitionFilePaths(task.filePaths, task.cwd ?? process.cwd());

  const stageCount =
    reviewPolicy === 'off' ? 1 :
    reviewPolicy === 'spec_only' ? 3 :
    5;
  const verbose = diagnostics?.verbose ?? false;
  let lastStageSeen: string | undefined;
  const verboseStreamRaw = verbose
    ? (diagnostics?.verboseStream ?? ((line: string) => { process.stderr.write(line + '\n'); }))
    : undefined;
  const verboseBatchIdEarly = heartbeatWiring?.batchId;
  const shortBatchEarly = verboseBatchIdEarly ? verboseBatchIdEarly.slice(0, 8) : '????????';
  const taskEventLogger = diagnostics?.logger;
  type EventField = string | number | boolean | null | undefined;
  const emitTaskEvent = (event: string, fields: Record<string, EventField>): void => {
    if (taskEventLogger && verboseBatchIdEarly !== undefined) {
      const cleaned: Record<string, EventField> = {};
      for (const [key, value] of Object.entries(fields)) {
        if (value !== undefined) cleaned[key] = value;
      }
      taskEventLogger.emit({ event, batchId: verboseBatchIdEarly, taskIndex, ...cleaned });
    }
    if (verboseStreamRaw) {
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
    diagnostics?.logger !== undefined;
  // Synthesize an onProgress sink when the caller didn't pass one — the
  // heartbeat needs a place to emit heartbeat events so the stage-change
  // detector below fires. Discards events if there is no external consumer.
  const synthOnProgress: RunTasksProgressCallback = onProgress ?? (() => {});
  const heartbeat = needHeartbeat
    ? new HeartbeatTimer(
        (event) => {
          if (event.kind === 'heartbeat') {
            // Emit on every heartbeat tick so the operator can confirm
            // the timer is actually firing. Stage-change lines are richer
            // but fire only on transitions; plain ticks let you see
            // per-5s progress inside a long-running stage.
            if (event.stage !== lastStageSeen) {
              if (lastStageSeen !== undefined) {
                emitTaskEvent('stage_change', { from: lastStageSeen, to: event.stage });
              }
              lastStageSeen = event.stage;
            }
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
  const verboseStream = verboseStreamRaw;
  emitTaskEvent('worker_start', { worker: resolved.provider.config.model });
  let prevEventAtMs = verbose ? Date.now() : 0;
  // Wrap whenever we have ANY consumer for InternalRunnerEvent (heartbeat,
  // verbose stream, or verbose logger). Previously this only wrapped when
  // the caller passed onProgress, so --verbose + HTTP handlers (which don't
  // pass onProgress) silently dropped every tool_call / turn_complete event.
  let textEmissionChars = 0;
  const markRunnerEvent = (): void => { lastRunnerEventAtMs = Date.now(); };
  const wrappedOnProgress = needHeartbeat
    ? (event: InternalRunnerEvent) => {
        if (event.kind === 'turn_start' || event.kind === 'text_emission' || event.kind === 'tool_call' || event.kind === 'turn_complete') {
          markRunnerEvent();
        }
        if (event.kind === 'turn_start') {
          heartbeat?.markEvent('llm');
          if (verbose) prevEventAtMs = Date.now();
          if (verbose) {
            emitTaskEvent('turn_start', {
              turn: event.turn,
              provider: event.provider,
              model: event.model,
            });
          }
        }
        if (event.kind === 'text_emission') {
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
          const now = verbose ? Date.now() : 0;
          const sincePrevMs = verbose ? now - prevEventAtMs : 0;
          if (verbose) prevEventAtMs = now;
          if (verbose) {
            emitTaskEvent('tool_call', {
              tool: event.toolSummary,
              duration_ms: sincePrevMs,
            });
          }
        }
        if (event.kind === 'turn_complete') {
          heartbeat?.markEvent('llm');
          const costUSD = computeCostUSD(
            event.cumulativeInputTokens,
            event.cumulativeOutputTokens,
            resolved.provider.config,
          );
          const savedCostUSD = computeSavedCostUSD(
            costUSD,
            event.cumulativeInputTokens,
            event.cumulativeOutputTokens,
            task.parentModel,
          );
          heartbeat?.updateCost(costUSD, savedCostUSD);
          const nowTurn = verbose ? Date.now() : 0;
          const turnDurMs = verbose ? nowTurn - prevEventAtMs : 0;
          if (verbose) prevEventAtMs = nowTurn;
          if (verbose) {
            emitTaskEvent('turn_complete', {
              input_tokens: event.cumulativeInputTokens,
              output_tokens: event.cumulativeOutputTokens,
              cost: costUSD,
              duration_ms: turnDurMs,
              provider: resolved.provider.config.model,
            });
          }
        }
      }
    : undefined;

  const cwd = task.cwd ?? process.cwd();
  const taskStartMs = Date.now();
  // Hard task-level wall-clock cap. Once Date.now() crosses this, no new
  // provider.run is dispatched (retries / tier-fallback short-circuit) and
  // any in-flight call gets a per-call timeoutMs clamped to remaining
  // budget so it returns its salvage promptly. The user gets *something*
  // back instead of an open-ended retry storm.
  const taskTimeoutMs = task.timeoutMs ?? config.defaults.timeoutMs ?? 1_800_000;
  const taskDeadlineMs = taskStartMs + taskTimeoutMs;
  // Stall watchdog: when no LLM / tool / text event has fired for this
  // many ms, the in-flight runner is force-aborted via `stallController`.
  // Catches "model is silently thinking forever" and "transport hung" —
  // both invisible to the wall-clock cap until the very end.
  const stallTimeoutMs = config.defaults.stallTimeoutMs ?? 600_000;
  const stallController = new AbortController();
  let lastRunnerEventAtMs = taskStartMs;
  let stallFired = false;
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
  const runningCostUSD = () => taskCostUSD();
  const policyEscalated: { spec: boolean; quality: boolean; diff: boolean } = { spec: false, quality: false, diff: false };
  const emitFallback = (p: FallbackEventParams) => {
    diagnostics?.logger?.fallback(p);
    emitTaskEvent('fallback', p as unknown as Record<string, EventField>);
  };
  const emitFallbackUnavailable = (p: FallbackUnavailableEventParams) => {
    diagnostics?.logger?.fallbackUnavailable(p);
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
    diagnostics?.logger?.escalation(p);
    emitTaskEvent('escalation', p as unknown as Record<string, EventField>);
    policyEscalated[loop] = true;
  };
  const emitEscalationUnavailable = (p: EscalationUnavailableEventParams) => {
    diagnostics?.logger?.escalationUnavailable(p);
    emitTaskEvent('escalation_unavailable', p as unknown as Record<string, EventField>);
  };
  // When the review loop aborts mid-flight, preserve any review-status info already set
  // on the base result (set by callers via abortReviewLoop({ ...res, specReviewStatus, ... })).
  // Defaults to 'changes_required' for whichever loop tripped — that's the only state the
  // loop ever fires from, by construction.
  function adaptForAllTiersUnavailable(base: RunResult, loop: 'spec' | 'quality', attempt: number): RunResult {
    const ship = lastNonRejectedImpl?.result ?? base;
    return {
      ...ship,
      status: 'incomplete',
      workerStatus: 'blocked',
      terminationReason: 'all_tiers_unavailable',
      reviewRounds: reviewRounds(),
      error: `runWithFallback: both tiers unavailable (loop=${loop}, attempt=${attempt}, role=implementer)`,
      agents: agentEnvelope(
        specReviewerHistory[specReviewerHistory.length - 1] ?? 'not_applicable',
        qualityReviewerHistory[qualityReviewerHistory.length - 1] ?? (reviewPolicy === 'full' ? 'not_applicable' : 'skipped'),
      ),
      stageStats: stats,
    } as RunResult;
  }

  function reviewDidNotReject(status: string): boolean {
    return status === 'approved' || status === 'skipped';
  }

  const implementerToolMode = task.tools ?? config.defaults.tools;
  const agentConfig = config.agents[resolved.slot];
  const implementerCapabilities = (agentConfig.capabilities ?? findModelCapabilities(agentConfig.model) ?? []) as ('web_search' | 'web_fetch')[];

  const agentEnvelope = (specReviewer: AgentType | 'skipped' | 'not_applicable', qualityReviewer: AgentType | 'skipped' | 'not_applicable') => {
    const selectedImpl = latestAttemptedImpl ?? lastNonRejectedImpl;
    const implementer = selectedImpl?.tier ?? resolved.slot;
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
    terminationReason: 'round_cap' | 'cost_ceiling',
    message: string,
    aborting: 'spec' | 'quality',
  ): RunResult => ({
    ...base,
    status: 'incomplete',
    workerStatus: 'review_loop_aborted',
    terminationReason,
    reviewRounds: reviewRounds(),
    error: message,
    specReviewStatus: aborting === 'spec' ? 'changes_required' : (base.specReviewStatus ?? 'approved'),
    qualityReviewStatus: aborting === 'quality' ? 'changes_required' : (base.qualityReviewStatus ?? 'skipped'),
    agents: agentEnvelope(
      specReviewerHistory[specReviewerHistory.length - 1] ?? 'not_applicable',
      qualityReviewerHistory[qualityReviewerHistory.length - 1] ?? (reviewPolicy === 'full' ? 'not_applicable' : 'skipped'),
    ),
    stageStats: stats,
  });
  const defaultVerification: VerifyStageResult = { status: 'skipped', steps: [], totalDurationMs: 0, skipReason: 'no_command' };
  let latestVerification: VerifyStageResult = defaultVerification;

  async function runVerificationStage(): Promise<VerifyStageResult> {
    emitTaskEvent('stage_change', { from: 'implementing', to: 'verifying' });
    heartbeat?.setStage('verifying', 4);
    const overallVerificationStart = Date.now();
    const verifyCostStart = runningCostUSD();
    const verification = await runVerifyStage({
      cwd,
      verifyCommand: task.verifyCommand,
      taskTimeoutMs: task.timeoutMs ?? config.defaults.timeoutMs ?? 1_800_000,
      taskStartMs,
    });
    latestVerification = verification;
    endVerifyStage(stats, overallVerificationStart, verifyCostStart,
      implementerAgentInfo, runningCostUSD(),
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
        : result.status === 'timeout' || cause === 'timeout' ? 'wall_clock'
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
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: null },
      turns: 0,
      filesRead: [],
      filesWritten: [],
      toolCalls: [],
      outputIsDiagnostic: true,
      escalationLog: [],
      error: workerError.message,
      errorCode: 'runner_crash',
      structuredError: { code: 'runner_crash', message: workerError.message },
      workerStatus: 'failed',
      workerError,
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
      errorCode: 'verify_command_error',
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
        errorCode: 'verify_command_error',
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
    if (headMoved) await recordWorkerCommits(baselineHead, 'HEAD');
    if (treeDirty) {
      const validCommit = implReport?.commit ?? await repairCommitMetadata(implReport?.commitDiagnostic ?? 'no commit block emitted');
      if (!validCommit) return;
      heartbeat?.setStage('committing', 7);
      const commitT0 = Date.now();
      const commitC0 = runningCostUSD();
      const c = await runCommitStage({ cwd, filesWritten: implResult.filesWritten, commit: validCommit });
      commits.push(c);
      endBaseStage(stats, 'committing', commitT0, commitC0, implementerAgentInfo, runningCostUSD());
    }
  }

  // Tracks the final RunResult across every exit path so the `finally` block
  // below fires `recorder.recordTaskCompleted` exactly once regardless of which
  // `return` the lifecycle takes — the success path, every early return inside
  // the try (reviewPolicy='off', diff-only, all-tiers-unavailable, …), and the
  // catch path. Without this, the recorder only fires on 2 of ~5 exit paths.
  let __finalRunResult: RunResult | undefined;
  const __recordOnce = (r: RunResult): RunResult => {
    if (__finalRunResult === undefined) __finalRunResult = r;
    return r;
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
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: null },
          turns: 0,
          filesRead: [],
          filesWritten: [],
          toolCalls: [],
          outputIsDiagnostic: true,
          escalationLog: [],
          error: `task.cwd ${cwd} had pre-existing modifications`,
          errorCode: 'dirty_worktree',
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
      call: (provider) => delegateWithEscalation(
        withDoneCondition(task),
        [provider],
        { explicitlyPinned: false, onProgress: wrappedOnProgress, taskDeadlineMs, abortSignal: stallController.signal },
      ),
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
      return __recordOnce(adaptForAllTiersUnavailable(initialImpl.result, 'spec', 0));
    }

    const implResult = initialImpl.result;
    latestAttemptedImpl = { tier: initialImpl.usedTier as AgentType, result: implResult };
    lastNonRejectedImpl = { tier: initialImpl.usedTier as AgentType, result: implResult };
    implementerHistory.push(initialImpl.usedTier as AgentType);

    endBaseStage(stats, 'implementing', implT0, implC0, implementerAgentInfo, runningCostUSD());
    specAttemptIndex = 1;

    const implReport = implResult.status === 'ok' ? parseStructuredReport(implResult.output) : undefined;
    const workerStatus = extractWorkerStatus(implReport);

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

    if (implResult.filesWritten.length === 0) {
      if (reviewPolicy === 'off') {
        emitTaskEvent('stage_change', { from: 'verifying', to: 'terminal' });
        const terminal = resolveOffTerminal({
          ...implResult,
          workerStatus,
          specReviewStatus: 'skipped',
          qualityReviewStatus: 'skipped',
          specReviewReason: 'skipped: reviewPolicy is off',
          qualityReviewReason: 'skipped: reviewPolicy is off',
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

    if (reviewPolicy === 'off') {
      emitTaskEvent('stage_change', { from: 'verifying', to: 'terminal' });
      const terminal = resolveOffTerminal({
        ...implResult,
        workerStatus,
        specReviewStatus: 'skipped',
        qualityReviewStatus: 'skipped',
        specReviewReason: 'skipped: reviewPolicy is off',
        qualityReviewReason: 'skipped: reviewPolicy is off',
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

    const evidence = isArtifactProducing
      ? await buildEvidence({ cwd, baselineHead, commits, verification, reviewPolicy })
      : { block: '', diffTruncated: false, fullDiff: '' };

    if (reviewPolicy === 'diff_only') {
      const diffUnavailable: UnavailableMap = new Map();
      const diffReviewerTier = pickReviewer({ loop: 'spec', attemptIndex: 0, baseTier: resolved.slot });
      emitTaskEvent('stage_change', { from: 'verifying', to: 'diff_review' });
      const diffReviewT0 = Date.now();
    const diffReviewC0 = runningCostUSD();
    heartbeat?.transition({ stage: 'diff_review' as never, stageIndex: 2, reviewRound: 1, attemptCap: 1 });
      const diffReviewT0_commit = Date.now();
    const diffReviewC0_commit = runningCostUSD();
    const diffCall = await runWithFallback<DiffReviewOrSkipped>({
        assigned: diffReviewerTier,
        providerFor,
        unavailableTiers: diffUnavailable,
        isTransportFailure: (r) => isReviewTransportFailure(r),
        getStatus: (r) => (r as { status?: RunStatus }).status,
        makeSyntheticFailure: () => makeSkippedReviewResult('all_tiers_unavailable'),
        call: (provider) => runDiffReview({ cwd, diff: evidence.fullDiff, diffTruncated: evidence.diffTruncated, verification, worker: { call: (prompt: string) => provider.run(prompt) } }),
      });
      if (diffCall.fallbackFired) {
        emitFallback({ batchId: heartbeatWiring?.batchId ?? '', taskIndex, loop: 'diff', attempt: 0, role: 'diffReviewer', assignedTier: diffReviewerTier, usedTier: diffCall.usedTier as AgentType, reason: diffCall.fallbackReason!, triggeringStatus: diffCall.fallbackTriggeringStatus, violatesSeparation: diffCall.usedTier === implementerHistory[implementerHistory.length - 1] });
        fallbackOverrides.push({ role: 'diffReviewer', loop: 'diff', attempt: 0, assigned: diffReviewerTier, used: diffCall.usedTier, reason: diffCall.fallbackReason!, triggeringStatus: diffCall.fallbackTriggeringStatus, bothUnavailable: diffCall.bothUnavailable });
      }
      if (diffCall.bothUnavailable) {
        emitFallbackUnavailable({ batchId: heartbeatWiring?.batchId ?? '', taskIndex, loop: 'diff', attempt: 0, role: 'diffReviewer', assignedTier: diffReviewerTier, reason: diffCall.unavailableReason! });
      }
      const verdict: DiffReviewOrSkipped = diffCall.bothUnavailable || isReviewTransportFailure(diffCall.result) ? makeSkippedReviewResult('all_tiers_unavailable') : diffCall.result;
      emitTaskEvent('review_decision', { stage: 'diff_review', verdict: 'kind' in verdict ? verdict.kind : 'skipped', round: 1 });
      endReviewStage(stats, 'diff_review', diffReviewT0_commit, diffReviewC0_commit, implementerAgentInfo, runningCostUSD(),
        // Diff review uses 'approve' | 'concerns' | 'reject' | 'transport_failure' (DiffReviewVerdict),
        // distinct from spec/quality verdicts. Map to the telemetry verdict enum here.
        'kind' in verdict
          ? (verdict.kind === 'approve' ? 'approved'
            : verdict.kind === 'concerns' ? 'concerns'
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
        implementationReport: effectiveImplReport,
        fileArtifactsMissing: implResult.status === 'ok' ? checkOutputTargets(outputTargets) : undefined,
        agents: agentEnvelope('skipped', 'skipped'),
        models: { implementer: implModel, specReviewer: reviewModel, qualityReviewer: null },
      }, verdict, verification, evidence.diffTruncated));
    }

    let finalImplResult = implResult;
    let finalImplReport = effectiveImplReport;
    let specResult: import('../review/spec-reviewer.js').SpecReviewOrSkipped;
    let specStatus: string;
    let specReport: typeof effectiveImplReport | undefined;
    let specReviewReason: string | undefined;

    heartbeat?.transition({ stage: 'spec_review', stageIndex: 2, reviewRound: 1, attemptCap: maxSpecRows });
    const initialReviewerTier = pickReviewer({ loop: 'spec', attemptIndex: 0, baseTier: resolved.slot });
    const specReviewT0 = Date.now();
    const specReviewC0 = runningCostUSD();
    const initialSpecReview = await runWithFallback<import('../review/spec-reviewer.js').SpecReviewOrSkipped>({
      assigned: initialReviewerTier,
      providerFor,
      unavailableTiers: specUnavailable,
      isTransportFailure: (r) => isReviewTransportFailure(r),
      getStatus: (r) => (r as { status?: RunStatus }).status,
      makeSyntheticFailure: () => makeSkippedReviewResult('all_tiers_unavailable'),
      call: (provider) => runSpecReview(provider, packet, effectiveImplReport, fileContents, implResult.toolCalls, task.planContext, evidence.block),
    });
    if (initialSpecReview.bothUnavailable) {
      emitFallbackUnavailable({ batchId: heartbeatWiring?.batchId ?? '', taskIndex, loop: 'spec', attempt: 0, role: 'specReviewer', assignedTier: initialReviewerTier, reason: initialSpecReview.unavailableReason! });
      fallbackOverrides.push({ role: 'specReviewer', loop: 'spec', attempt: 0, assigned: initialReviewerTier, used: initialSpecReview.usedTier, reason: initialSpecReview.unavailableReason!, triggeringStatus: initialSpecReview.fallbackTriggeringStatus, bothUnavailable: true });
      specReviewerHistory.push('skipped');
    } else {
      specReviewerHistory.push(initialSpecReview.usedTier as AgentType);
      if (initialSpecReview.fallbackFired) {
        emitFallback({ batchId: heartbeatWiring?.batchId ?? '', taskIndex, loop: 'spec', attempt: 0, role: 'specReviewer', assignedTier: initialReviewerTier, usedTier: initialSpecReview.usedTier as AgentType, reason: initialSpecReview.fallbackReason!, triggeringStatus: initialSpecReview.fallbackTriggeringStatus, violatesSeparation: initialSpecReview.usedTier === implementerHistory[implementerHistory.length - 1] });
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

    while (specStatus === 'changes_required') {
      if (specAttemptIndex >= maxSpecRows) return abortReviewLoop(finalImplResult, 'round_cap', 'review round cap reached before spec rework', 'spec');
      const currentCostUSD = taskCostUSD();
      if (currentCostUSD !== null && maxCostUSD !== undefined && currentCostUSD >= 0.8 * maxCostUSD) {
        emitTaskEvent('cost_check', { stage: 'spec_rework', tripped: true, cost_used_usd: currentCostUSD, cost_cap_usd: maxCostUSD, cost_available: true });
        return abortReviewLoop(finalImplResult, 'cost_ceiling', 'cost ceiling reached before spec rework', 'spec');
      }
      const decision = pickEscalation({ loop: 'spec', attemptIndex: specAttemptIndex, baseTier: resolved.slot });
      if (decision.isEscalated) emitEscalationEvent('spec', specAttemptIndex, decision);
      emitTaskEvent('stage_change', { from: 'spec_review', to: 'spec_rework', attempt: specAttemptIndex, attemptCap: maxSpecRows, implTier: decision.impl, reviewerTier: decision.reviewer, escalated: decision.isEscalated });
      heartbeat?.transition({ stage: 'spec_rework', stageIndex: 3, reviewRound: specAttemptIndex, attemptCap: maxSpecRows });
      const feedback = specResult.findings.length > 0 ? `\n\n## Spec Review Feedback (round ${specAttemptIndex}):\n${specResult.findings.map(f => `- ${f}`).join('\n')}` : '';
      const reworkTask = withDoneCondition({ ...task, prompt: `${task.prompt}${feedback}` });
      const reworkCall = await runWithFallback<RunResult>({ assigned: decision.impl, providerFor, unavailableTiers: specUnavailable, isTransportFailure: (r) => TRANSPORT_FAILURES.has(r.status) && r.capExhausted === undefined, getStatus: (r) => r.status, makeSyntheticFailure: (assigned) => makeSyntheticRunResult(assigned, 'all_tiers_unavailable'), call: (provider) => delegateWithEscalation(reworkTask, [provider], { explicitlyPinned: true, onProgress: wrappedOnProgress, taskDeadlineMs, abortSignal: stallController.signal }) });
      if (reworkCall.fallbackFired || reworkCall.bothUnavailable) fallbackOverrides.push({ role: 'implementer', loop: 'spec', attempt: specAttemptIndex, assigned: decision.impl, used: reworkCall.usedTier, reason: (reworkCall.fallbackReason ?? reworkCall.unavailableReason)!, triggeringStatus: reworkCall.fallbackTriggeringStatus, bothUnavailable: reworkCall.bothUnavailable });
      if (reworkCall.fallbackFired) {
        emitFallback({ batchId: heartbeatWiring?.batchId ?? '', taskIndex, loop: 'spec', attempt: specAttemptIndex, role: 'implementer', assignedTier: decision.impl, usedTier: reworkCall.usedTier as AgentType, reason: reworkCall.fallbackReason!, triggeringStatus: reworkCall.fallbackTriggeringStatus, violatesSeparation: false });
        if (decision.isEscalated && reworkCall.fallbackReason === 'not_configured') emitEscalationUnavailable({ batchId: heartbeatWiring?.batchId ?? '', taskIndex, loop: 'spec', attempt: specAttemptIndex, role: 'implementer', wantedTier: decision.impl, reason: reworkCall.fallbackReason });
      }
      if (reworkCall.bothUnavailable) {
        emitFallbackUnavailable({ batchId: heartbeatWiring?.batchId ?? '', taskIndex, loop: 'spec', attempt: specAttemptIndex, role: 'implementer', assignedTier: decision.impl, reason: reworkCall.unavailableReason! });
        if (decision.isEscalated) emitEscalationUnavailable({ batchId: heartbeatWiring?.batchId ?? '', taskIndex, loop: 'spec', attempt: specAttemptIndex, role: 'implementer', wantedTier: decision.impl, reason: reworkCall.unavailableReason! });
        return __recordOnce(adaptForAllTiersUnavailable(reworkCall.result, 'spec', specAttemptIndex));
      }
      finalImplResult = reworkCall.result;
      latestAttemptedImpl = { tier: reworkCall.usedTier as AgentType, result: finalImplResult };
      implementerHistory.push(reworkCall.usedTier as AgentType);
      const reworkReport = parseStructuredReport(finalImplResult.output);
      finalImplReport = reworkReport.summary ? reworkReport : buildFallbackImplReport(finalImplResult);
      fileContents = await readImplementerFileContents(finalImplResult.filesWritten, task.cwd);
      heartbeat?.transition({ stage: 'spec_review', stageIndex: 2, reviewRound: specAttemptIndex + 1, attemptCap: maxSpecRows });
      const reviewCall = await runWithFallback<import('../review/spec-reviewer.js').SpecReviewOrSkipped>({ assigned: decision.reviewer, providerFor, unavailableTiers: specUnavailable, isTransportFailure: (r) => isReviewTransportFailure(r), getStatus: (r) => (r as { status?: RunStatus }).status, makeSyntheticFailure: () => makeSkippedReviewResult('all_tiers_unavailable'), call: (provider) => runSpecReview(provider, packet, finalImplReport, fileContents, finalImplResult.toolCalls, task.planContext, evidence.block) });
      if (reviewCall.bothUnavailable) {
        emitFallbackUnavailable({ batchId: heartbeatWiring?.batchId ?? '', taskIndex, loop: 'spec', attempt: specAttemptIndex, role: 'specReviewer', assignedTier: decision.reviewer, reason: reviewCall.unavailableReason! });
        fallbackOverrides.push({ role: 'specReviewer', loop: 'spec', attempt: specAttemptIndex, assigned: decision.reviewer, used: reviewCall.usedTier, reason: reviewCall.unavailableReason!, triggeringStatus: reviewCall.fallbackTriggeringStatus, bothUnavailable: true });
        specReviewerHistory.push('skipped');
      } else {
        specReviewerHistory.push(reviewCall.usedTier as AgentType);
        if (reviewCall.fallbackFired) {
          emitFallback({ batchId: heartbeatWiring?.batchId ?? '', taskIndex, loop: 'spec', attempt: specAttemptIndex, role: 'specReviewer', assignedTier: decision.reviewer, usedTier: reviewCall.usedTier as AgentType, reason: reviewCall.fallbackReason!, triggeringStatus: reviewCall.fallbackTriggeringStatus, violatesSeparation: reviewCall.usedTier === implementerHistory[implementerHistory.length - 1] });
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

    let qualityResult: LegacyQualityReviewResult = { status: 'skipped', report: undefined, findings: [], errorReason: reviewPolicy === 'full' ? 'all_tiers_unavailable' : 'skipped: reviewPolicy is spec_only' };
    // Hoisted so endReviewStage (called after this block) can read them on the
    // success path. When the quality review is skipped (`reviewPolicy !== 'full'`),
    // the values stay at 0/null and the corresponding stage entry remains in its
    // `entered: false` default — endReviewStage is never called.
    let qualityReviewT0 = 0;
    let qualityReviewC0: number | null = null;
    if (reviewPolicy === 'full') {
      qualityUnavailable = new Map();
      const qualityReviewerTier = pickReviewer({ loop: 'quality', attemptIndex: 0, baseTier: resolved.slot });
      heartbeat?.transition({ stage: 'quality_review', stageIndex: 4, reviewRound: 1, attemptCap: maxQualityRows });
      qualityReviewT0 = Date.now();
      qualityReviewC0 = runningCostUSD();
      const initialQuality = await runWithFallback<LegacyQualityReviewResult>({ assigned: qualityReviewerTier, providerFor, unavailableTiers: qualityUnavailable, isTransportFailure: (r) => isReviewTransportFailure(r), getStatus: (r) => (r as { status?: RunStatus }).status, makeSyntheticFailure: () => makeSkippedReviewResult('all_tiers_unavailable'), call: (provider) => runQualityReview(provider, packet, specReport ?? finalImplReport, fileContents, finalImplResult.toolCalls, finalImplResult.filesWritten, evidence.block) });
      if (initialQuality.bothUnavailable) {
        emitFallbackUnavailable({ batchId: heartbeatWiring?.batchId ?? '', taskIndex, loop: 'quality', attempt: 0, role: 'qualityReviewer', assignedTier: qualityReviewerTier, reason: initialQuality.unavailableReason! });
        fallbackOverrides.push({ role: 'qualityReviewer', loop: 'quality', attempt: 0, assigned: qualityReviewerTier, used: initialQuality.usedTier, reason: initialQuality.unavailableReason!, triggeringStatus: initialQuality.fallbackTriggeringStatus, bothUnavailable: true });
        qualityReviewerHistory.push('skipped');
      } else {
        qualityReviewerHistory.push(initialQuality.usedTier as AgentType);
        if (initialQuality.fallbackFired) {
          emitFallback({ batchId: heartbeatWiring?.batchId ?? '', taskIndex, loop: 'quality', attempt: 0, role: 'qualityReviewer', assignedTier: qualityReviewerTier, usedTier: initialQuality.usedTier as AgentType, reason: initialQuality.fallbackReason!, triggeringStatus: initialQuality.fallbackTriggeringStatus, violatesSeparation: initialQuality.usedTier === implementerHistory[implementerHistory.length - 1] });
          fallbackOverrides.push({ role: 'qualityReviewer', loop: 'quality', attempt: 0, assigned: qualityReviewerTier, used: initialQuality.usedTier, reason: initialQuality.fallbackReason!, triggeringStatus: initialQuality.fallbackTriggeringStatus, bothUnavailable: false });
        }
      }
      qualityResult = initialQuality.result;
      let prevQualityFindings = [...(qualityResult.findings ?? [])];
      qualityAttemptIndex = 1;
      while (qualityResult.status === 'changes_required') {
        if (qualityAttemptIndex >= maxQualityRows) return abortReviewLoop(finalImplResult, 'round_cap', 'review round cap reached before quality rework', 'quality');
        const currentCostUSD = taskCostUSD();
        if (currentCostUSD !== null && maxCostUSD !== undefined && currentCostUSD >= 0.8 * maxCostUSD) {
          emitTaskEvent('cost_check', { stage: 'quality_rework', tripped: true, cost_used_usd: currentCostUSD, cost_cap_usd: maxCostUSD, cost_available: true });
          return abortReviewLoop(finalImplResult, 'cost_ceiling', 'cost ceiling reached before quality rework', 'quality');
        }
        const decision = pickEscalation({ loop: 'quality', attemptIndex: qualityAttemptIndex, baseTier: resolved.slot });
        if (decision.isEscalated) emitEscalationEvent('quality', qualityAttemptIndex, decision);
        emitTaskEvent('stage_change', { from: 'quality_review', to: 'quality_rework', attempt: qualityAttemptIndex, attemptCap: maxQualityRows, implTier: decision.impl, reviewerTier: decision.reviewer, escalated: decision.isEscalated });
        heartbeat?.transition({ stage: 'quality_rework', stageIndex: 5, reviewRound: qualityAttemptIndex, attemptCap: maxQualityRows });
        const feedback = qualityResult.findings.length > 0 ? `\n\n## Quality Review Feedback (round ${qualityAttemptIndex}):\n${qualityResult.findings.map(f => `- ${f}`).join('\n')}` : '';
        const reworkTask = withDoneCondition({ ...task, prompt: `${task.prompt}${feedback}` });
        const reworkCall = await runWithFallback<RunResult>({ assigned: decision.impl, providerFor, unavailableTiers: qualityUnavailable, isTransportFailure: (r) => TRANSPORT_FAILURES.has(r.status) && r.capExhausted === undefined, getStatus: (r) => r.status, makeSyntheticFailure: (assigned) => makeSyntheticRunResult(assigned, 'all_tiers_unavailable'), call: (provider) => delegateWithEscalation(reworkTask, [provider], { explicitlyPinned: true, onProgress: wrappedOnProgress, taskDeadlineMs, abortSignal: stallController.signal }) });
        if (reworkCall.fallbackFired || reworkCall.bothUnavailable) fallbackOverrides.push({ role: 'implementer', loop: 'quality', attempt: qualityAttemptIndex, assigned: decision.impl, used: reworkCall.usedTier, reason: (reworkCall.fallbackReason ?? reworkCall.unavailableReason)!, triggeringStatus: reworkCall.fallbackTriggeringStatus, bothUnavailable: reworkCall.bothUnavailable });
        if (reworkCall.fallbackFired) emitFallback({ batchId: heartbeatWiring?.batchId ?? '', taskIndex, loop: 'quality', attempt: qualityAttemptIndex, role: 'implementer', assignedTier: decision.impl, usedTier: reworkCall.usedTier as AgentType, reason: reworkCall.fallbackReason!, triggeringStatus: reworkCall.fallbackTriggeringStatus, violatesSeparation: false });
        if (reworkCall.bothUnavailable) {
          emitFallbackUnavailable({ batchId: heartbeatWiring?.batchId ?? '', taskIndex, loop: 'quality', attempt: qualityAttemptIndex, role: 'implementer', assignedTier: decision.impl, reason: reworkCall.unavailableReason! });
          if (decision.isEscalated) emitEscalationUnavailable({ batchId: heartbeatWiring?.batchId ?? '', taskIndex, loop: 'quality', attempt: qualityAttemptIndex, role: 'implementer', wantedTier: decision.impl, reason: reworkCall.unavailableReason! });
          return __recordOnce(adaptForAllTiersUnavailable(reworkCall.result, 'quality', qualityAttemptIndex));
        }
        finalImplResult = reworkCall.result;
        latestAttemptedImpl = { tier: reworkCall.usedTier as AgentType, result: finalImplResult };
        implementerHistory.push(reworkCall.usedTier as AgentType);
        const reworkReport = parseStructuredReport(finalImplResult.output);
        finalImplReport = reworkReport.summary ? reworkReport : buildFallbackImplReport(finalImplResult);
        fileContents = await readImplementerFileContents(finalImplResult.filesWritten, task.cwd);
        heartbeat?.transition({ stage: 'quality_review', stageIndex: 4, reviewRound: qualityAttemptIndex + 1, attemptCap: maxQualityRows });
        const reviewCall = await runWithFallback<LegacyQualityReviewResult>({ assigned: decision.reviewer, providerFor, unavailableTiers: qualityUnavailable, isTransportFailure: (r) => isReviewTransportFailure(r), getStatus: (r) => (r as { status?: RunStatus }).status, makeSyntheticFailure: () => makeSkippedReviewResult('all_tiers_unavailable'), call: (provider) => runQualityReview(provider, packet, finalImplReport, fileContents, finalImplResult.toolCalls, finalImplResult.filesWritten, evidence.block) });
        if (reviewCall.bothUnavailable) {
          emitFallbackUnavailable({ batchId: heartbeatWiring?.batchId ?? '', taskIndex, loop: 'quality', attempt: qualityAttemptIndex, role: 'qualityReviewer', assignedTier: decision.reviewer, reason: reviewCall.unavailableReason! });
          fallbackOverrides.push({ role: 'qualityReviewer', loop: 'quality', attempt: qualityAttemptIndex, assigned: decision.reviewer, used: reviewCall.usedTier, reason: reviewCall.unavailableReason!, triggeringStatus: reviewCall.fallbackTriggeringStatus, bothUnavailable: true });
          qualityReviewerHistory.push('skipped');
        } else {
          qualityReviewerHistory.push(reviewCall.usedTier as AgentType);
          if (reviewCall.fallbackFired) {
            emitFallback({ batchId: heartbeatWiring?.batchId ?? '', taskIndex, loop: 'quality', attempt: qualityAttemptIndex, role: 'qualityReviewer', assignedTier: decision.reviewer, usedTier: reviewCall.usedTier as AgentType, reason: reviewCall.fallbackReason!, triggeringStatus: reviewCall.fallbackTriggeringStatus, violatesSeparation: reviewCall.usedTier === implementerHistory[implementerHistory.length - 1] });
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

    const specAggregateStatus = (['approved', 'changes_required', 'skipped', 'error', 'api_error', 'network_error', 'timeout'].includes(specStatus) ? specStatus : 'error') as 'approved' | 'changes_required' | 'skipped' | 'error' | 'api_error' | 'network_error' | 'timeout';

    endReviewStage(stats, 'spec_review', specReviewT0, specReviewC0, implementerAgentInfo, runningCostUSD(),
      specStatus === 'approved' ? 'approved'
        : specStatus === 'changes_required' ? 'changes_required'
        : specStatus === 'skipped' ? 'skipped'
        : specStatus === 'not_applicable' ? 'not_applicable'
        : 'error',
      specAttemptIndex - 1);
    const qualityAggregateStatus = qualityResult.status as 'approved' | 'changes_required' | 'skipped' | 'error' | 'api_error' | 'network_error' | 'timeout';

    endReviewStage(stats, 'quality_review', qualityReviewT0, qualityReviewC0, implementerAgentInfo, runningCostUSD(),
      qualityResult.status === 'approved' ? 'approved'
        : qualityResult.status === 'changes_required' ? 'changes_required'
        : qualityResult.status === 'skipped' ? 'skipped'
        : 'error',
      qualityAttemptIndex - 1);
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
    const specEnvelopeStatus = (specStatus === 'api_error' || specStatus === 'network_error' || specStatus === 'timeout' ? 'error' : specStatus) as 'approved' | 'changes_required' | 'skipped' | 'error' | 'not_applicable';
    const qualityEnvelopeStatus = qualityResult.status === 'api_error' || qualityResult.status === 'network_error' || qualityResult.status === 'timeout' ? 'error' : qualityResult.status;

    const runResult: RunResult = {
      ...finalImplResult,
      status: finalStatus,
      workerStatus: finalWorkerStatus,
      concerns,
      specReviewStatus: specEnvelopeStatus,
      qualityReviewStatus: qualityEnvelopeStatus,
      stageStats: stats,
      specReviewReason: 'errorReason' in specResult ? specResult.errorReason : undefined,
      qualityReviewReason: 'errorReason' in qualityResult ? qualityResult.errorReason : undefined,
      structuredReport: aggregated,
      implementationReport: finalImplReport,
      specReviewReport: specReport,
      qualityReviewReport: qualityResult.report,
      filePathsSkipped,
      agents: agentEnvelope(
        specReviewerHistory[specReviewerHistory.length - 1] ?? 'not_applicable',
        qualityReviewerHistory[qualityReviewerHistory.length - 1] ?? (reviewPolicy === 'full' ? 'not_applicable' : 'skipped'),
      ),
      models: {
        implementer: implModel,
        specReviewer: reviewModel,
        qualityReviewer: reviewPolicy === 'full' ? reviewModel : null,
      },
      fileArtifactsMissing,
      commits,
      commitError,
      verification,
    };

    return __recordOnce(runResult);
  } catch (err) {
    const errorRunResult = withVerification(workerErrorResult(err));
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
        });
      } catch { /* silent */ }
    }
    heartbeat?.setStage('terminal', 8);
    heartbeat?.stop();
    clearInterval(stallWatchdogInterval);
  }
}
