import type {
  TaskSpec,
  RunResult,
  MultiModelConfig,
  Provider,
  AgentType,
} from '../types.js';
import type { ProgressEvent, RunTasksRuntime, RunStatus } from '../providers/runner-types.js';
import type { HeartbeatTickInfo } from '../bounded-execution/activity-tracker.js';
import type { HttpServerLog } from '../events/http-server-log.js';
import type { EventEmitter } from '../events/event-emitter.js';
import type { ExecutionContext } from './lifecycle-context.js';
import type { LifecycleState } from './stage-plan-types.js';
import type { ResolvedAgent } from '../escalation/agent-resolver.js';
import { LifecycleDispatcher } from './lifecycle-dispatcher.js';
import { createDefaultReviewerEngine, createDefaultAnnotatorEngine } from '../review/default-engines.js';
import { WallClockGuard } from '../bounded-execution/wall-clock-guard.js';
import { ATTEMPT_BUDGETS, type ToolCategory } from '../escalation/escalation-policy.js';
import { pickEscalation } from '../escalation/policy.js';
import { resolveAgent } from '../escalation/agent-resolver.js';
import { expandContextBlocks } from '../stores/expand-context-blocks.js';
import { delegateWithEscalation } from '../escalation/delegate-with-escalation.js';
import { parseStructuredReport } from '../reporting/structured-report.js';
import { mergeStageStats } from './merge-stage-stats.js';
import { startStallWatchdog } from '../bounded-execution/stall-watchdog.js';
import { dispatchParallelCriteria } from './parallel-criteria-dispatcher.js';
import { READ_ONLY_ROUTES, isReadOnlyRoute, type ReadOnlyRouteName } from './parallel-criteria-routes.js';
import { makeRunnerShell } from '../providers/make-runner-shell.js';
import { readFile as fsReadFile } from 'fs/promises';
export function errorResult(error: string): RunResult {
  return {
    output: `Sub-agent error: ${error}`,
    status: 'error',
    usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 },
    turns: 0,
    filesRead: [],
    filesWritten: [],
    toolCalls: [],
    outputIsDiagnostic: true,
    escalationLog: [],
    parsedFindings: null,
    error,
  };
}

export type ResolvedTask =
  | { task: TaskSpec; resolved: { slot: AgentType; provider: Provider } }
  | { task: TaskSpec; error: string; errorCode: string };

export type RunTasksProgressCallback = (
  taskIndex: number,
  event: ProgressEvent,
) => void;

export interface RunTasksOptions {
  onProgress?: RunTasksProgressCallback;
  runtime?: RunTasksRuntime;
  batchId?: string;
  recordHeartbeat?: (tick: HeartbeatTickInfo) => void;
  logger?: HttpServerLog;
  verbose?: boolean;
  verboseStream?: (line: string) => void;
  recorder?: {
    recordTaskCompleted: (ctx: {
      route: string;
      taskSpec: TaskSpec;
      runResult: RunResult;
      client: string;
      mainModel: string | null;
      reviewPolicy?: 'full' | 'quality_only' | 'diff_only' | 'none';
      verifyCommandPresent?: boolean;
    }) => void;
  };
  route?: string;
  client?: string;
  bus?: EventEmitter;
  qualityReviewPromptBuilder?: (ctx: { workerOutput: string; brief: string }) => string;
  reviewerEngine?: import('../review/reviewer-engine.js').ReviewerEngine;
  annotatorEngine?: import('../review/annotator-engine.js').AnnotatorEngine;
}

export async function runTasks(
  tasks: TaskSpec[],
  config: MultiModelConfig,
  options: RunTasksOptions = {},
): Promise<RunResult[]> {
  if (tasks.length === 0) return [];

  const expandedTasks: (TaskSpec | { error: string })[] = tasks.map((task) => {
    try {
      return expandContextBlocks(task, options.runtime?.contextBlockStore);
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  const resolved: ResolvedTask[] = expandedTasks.map((entry, idx): ResolvedTask => {
    if ('error' in entry) {
      return { task: tasks[idx], error: entry.error, errorCode: 'context_block_not_found' };
    }
    const task = entry;
    const agentType: AgentType = task.agentType ?? 'standard';
    try {
      const resolved_agent = resolveAgent(agentType, config);
      return { task, resolved: resolved_agent };
    } catch (err) {
      return {
        task,
        error: err instanceof Error ? err.message : String(err),
        errorCode: 'agent_not_configured',
      };
    }
  });

  if (resolved.length > 1) {
    const PARALLEL_SAFETY_SUFFIX =
      '\n\nYou are running in parallel with other tasks. ' +
      'Do NOT run full-project build commands (`npm run build`, `tsc`, `cargo build`). ' +
      'Only run task-specific test commands if provided.';

    for (const r of resolved) {
      if ('error' in r) continue;
      r.task = {
        ...r.task,
        prompt: r.task.prompt + PARALLEL_SAFETY_SUFFIX +
          (r.task.testCommand ? `\nTo verify your work, run: \`${r.task.testCommand}\`` : ''),
      };
    }
  }

  return Promise.all(
    resolved.map((r, index): Promise<RunResult> => {
      if ('error' in r) {
        return Promise.resolve({ ...errorResult(r.error), errorCode: r.errorCode });
      }
      return runTaskViaDispatcher({
        task: r.task,
        resolved: r.resolved,
        config,
        taskIndex: index,
        ...(options.onProgress && { onProgress: options.onProgress }),
        ...(options.batchId !== undefined && { batchId: options.batchId }),
        ...(options.recordHeartbeat && { recordHeartbeat: options.recordHeartbeat }),
        ...(options.logger && { logger: options.logger }),
        verbose: options.verbose ?? config.diagnostics?.verbose ?? false,
        ...(options.verboseStream && { verboseStream: options.verboseStream }),
        ...(options.recorder && { recorder: options.recorder }),
        ...(options.route !== undefined && { route: options.route }),
        ...(options.client !== undefined && { client: options.client }),
        ...(options.bus && { bus: options.bus }),
        ...(options.qualityReviewPromptBuilder && { qualityReviewPromptBuilder: options.qualityReviewPromptBuilder }),
        ...(options.reviewerEngine && { reviewerEngine: options.reviewerEngine }),
        ...(options.annotatorEngine && { annotatorEngine: options.annotatorEngine }),
      });
    }),
  );
}

export { extractPlanSection } from './plan-extraction.js';

export interface DispatchTaskInput {
  task: TaskSpec;
  resolved: ResolvedAgent;
  config: MultiModelConfig;
  taskIndex: number;
  onProgress?: (taskIndex: number, event: ProgressEvent) => void;
  batchId?: string;
  recordHeartbeat?: (tick: HeartbeatTickInfo) => void;
  logger?: HttpServerLog;
  verbose?: boolean;
  verboseStream?: (line: string) => void;
  recorder?: ExecutionContext['recorder'];
  route?: string;
  client?: string;
  /** Calling agent's model (e.g., claude-opus-4-7), threaded into telemetry as mainModel.
   *  Sourced from X-MMA-Main-Model header → execution-context → here. */
  mainModel?: string | null;
  bus?: EventEmitter;
  /** Context block store for expanding contextBlockIds into the task's prompt
   *  before dispatch. Without this, the worker LLM never sees the prior-round
   *  audit/review report referenced by contextBlockIds. */
  contextBlockStore?: import('../stores/context-block-tool.js').ContextBlockStore;
  qualityReviewPromptBuilder?: (ctx: { workerOutput: string; brief: string }) => string;
  reviewerEngine?: import('../review/reviewer-engine.js').ReviewerEngine;
  annotatorEngine?: import('../review/annotator-engine.js').AnnotatorEngine;
}

function toolCategoryForRoute(route: string | undefined): ToolCategory {
  if (route === 'investigate' || route === 'review' || route === 'audit' || route === 'debug' || route === 'verify') return 'read_only';
  if (route === 'research') return 'research';
  if (route === 'register-context-block') return 'assist';
  return 'artifact_producing';
}

function buildExecutionContext(input: DispatchTaskInput): ExecutionContext {
  const { resolved, config } = input;
  // Expand contextBlockIds into the task's prompt up-front so every downstream
  // dispatch path (legacy executor + new lifecycle) sees the materialized
  // context. Throwing here surfaces missing-block errors at the dispatcher
  // boundary rather than silently dropping them on the floor.
  const task = input.contextBlockStore
    ? expandContextBlocks(input.task, input.contextBlockStore)
    : input.task;
  const cwd = task.cwd ?? process.cwd();
  const timeoutMs = task.timeoutMs ?? config.defaults?.timeoutMs ?? 1_800_000;
  const stallTimeoutMs = config.defaults?.stallTimeoutMs ?? 300_000;
  const startMs = Date.now();

  const providers: Partial<Record<AgentType, Provider>> = {};
  providers[resolved.slot] = resolved.provider;
  try {
    const otherTier: AgentType = resolved.slot === 'standard' ? 'complex' : 'standard';
    const other = resolveAgent(otherTier, config);
    providers[otherTier] = other.provider;
  } catch {
    /* other tier not configured — leave undefined */
  }

  return {
    task,
    taskIndex: input.taskIndex,
    config,
    cwd,
    ...(input.batchId !== undefined && { batchId: input.batchId }),
    route: input.route ?? '',
    client: input.client ?? '',
    mainModel: input.mainModel ?? null,
    ...(input.contextBlockStore && { contextBlockStore: input.contextBlockStore }),
    assignedTier: resolved.slot,
    implementerProvider: resolved.provider,
    escalationProvider: providers[resolved.slot === 'standard' ? 'complex' : 'standard'],
    providers,
    implementerIdentity: undefined,
    timing: { startMs, timeoutMs, deadlineMs: startMs + timeoutMs, stallTimeoutMs },
    budgets: { maxCostUSD: task.maxCostUSD ?? config.defaults?.maxCostUSD },
    wallClockGuard: new WallClockGuard(timeoutMs),
    stall: { controller: new AbortController(), lastEventAtMs: startMs, fired: false },
    implementerToolMode: task.tools,
    ...(input.qualityReviewPromptBuilder && { qualityReviewPromptBuilder: input.qualityReviewPromptBuilder }),
    bus: input.bus,
    heartbeat: undefined,
    logger: input.logger,
    verboseStream: input.verboseStream ?? ((line: string) => { process.stderr.write(line); }),
    verbose: input.verbose ?? false,
    ...(input.recordHeartbeat && { recordHeartbeat: input.recordHeartbeat }),
    ...(input.recorder && { recorder: input.recorder }),
    outputTargets: [],
    reviewerEngine: input.reviewerEngine ?? createDefaultReviewerEngine(),
    annotatorEngine: input.annotatorEngine ?? createDefaultAnnotatorEngine(),
  };
}

export async function runTaskViaDispatcher(
  input: DispatchTaskInput,
  dispatcher: LifecycleDispatcher = new LifecycleDispatcher(),
): Promise<RunResult> {
  // Gap 1 fix: expand contextBlockIds into the task's prompt once, up-front,
  // so the SAME expanded task object reaches BOTH state.task AND
  // executionContext.task (single source of truth — no two references).
  // buildExecutionContext also expands internally, but that becomes a no-op
  // because expandContextBlocks strips contextBlockIds on first pass.
  const expandedTask = input.contextBlockStore
    ? expandContextBlocks(input.task, input.contextBlockStore)
    : input.task;

  const executionContext = buildExecutionContext({ ...input, task: expandedTask });
  const route = input.route ?? '';
  const toolCategory = toolCategoryForRoute(route);

  void ATTEMPT_BUDGETS[toolCategory];

  // Arm the orchestrator stall watchdog. Spec §4.7: the AbortController on
  // ctx.stall has been declared since v3.x but never armed; this wires the
  // timer that fires .abort() after stallTimeoutMs of no runner events.
  // Disposed in finally{} below so it's torn down on the success path too.
  const stopWatchdog = startStallWatchdog({
    stall: executionContext.stall,
    timing: executionContext.timing,
    ...(executionContext.bus && { bus: executionContext.bus }),
    ...(executionContext.batchId !== undefined && { batchId: executionContext.batchId }),
    ...(executionContext.taskIndex !== undefined && { taskIndex: executionContext.taskIndex }),
  });

  let out;
  try {
    out = await dispatcher.dispatch({
    route,
    toolCategory,
    rawRequest: { tasks: [expandedTask] },
    context: { task: expandedTask, executionContext },
    executor: async (_rawRequest: unknown, state: LifecycleState): Promise<undefined> => {
      const task = state.task as TaskSpec | undefined;
      const ctx = state.executionContext as ExecutionContext | undefined;
      if (!task || !ctx) {
        throw new Error(`runTaskViaDispatcher: state.task / state.executionContext not set for route '${route}'`);
      }
      const baseTier: AgentType = ctx.assignedTier;
      const decision = pickEscalation({ loop: 'spec', attemptIndex: 0, baseTier });
      const provider = ctx.providers[decision.impl] as Provider | undefined;
      if (!provider) {
        state.lastRunResult = {
          output: '',
          status: 'error',
          usage: { inputTokens: 0, outputTokens: 0 },
          turns: 0,
          filesRead: [],
          filesWritten: [],
          toolCalls: [],
          outputIsDiagnostic: true,
          escalationLog: [],
          parsedFindings: null,
          error: `no provider configured for tier '${decision.impl}'`,
          errorCode: 'all_tiers_unavailable',
          workerStatus: 'failed',
        } as unknown as RunResult;
        state.terminal = true;
        return undefined;
      }
      // Read-only routes (audit/review/verify/debug/investigate) fan out
      // one sub-worker per criterion via the parallel-criteria dispatcher.
      // Spec §4.6: prime the prompt cache once, dispatch N sub-workers in
      // parallel, retry failed sub-workers once on the warm cache,
      // synthesize a RunResult with workerOutputs[] for the merge annotator.
      if (toolCategory === 'read_only' && isReadOnlyRoute(route)) {
        try {
          // A12: when the audit task carries auditType='plan', use the
          // plan-audit route spec (different criteria + orientation +
          // semantics) instead of the default audit spec. Other audit
          // types (default/security/performance) and other read-only
          // routes use their static route spec unchanged.
          const taskWithAuditType = task as TaskSpec & { auditType?: string };
          const lookupKey: ReadOnlyRouteName =
            (route === 'audit' && taskWithAuditType.auditType === 'plan')
              ? 'audit_plan'
              : route;
          const routeSpec = READ_ONLY_ROUTES[lookupKey];
          const taskWithFiles = task as TaskSpec & { filePaths?: string[]; document?: string };
          const filePaths = Array.isArray(taskWithFiles.filePaths) ? taskWithFiles.filePaths : [];
          const preReadFiles: Record<string, string> = {};
          for (const fp of filePaths) {
            try {
              preReadFiles[fp] = await fsReadFile(fp, 'utf8');
            } catch {
              // tolerated — sub-worker can read on demand via tools
            }
          }
          // Target content for the cached prefix. Preference order:
          //   1. parallelTarget — pure user question/work/problem, no
          //      legacy format spec (set by the route's buildTaskSpec).
          //   2. document — inlined doc (audit's primary input shape).
          //   3. task.prompt — last-resort fallback. AVOID: it embeds the
          //      legacy monolithic format spec (## Summary / ## Citations
          //      for investigate, etc.), which competes with our `## Finding
          //      N:` shape and confuses the worker about output format.
          const taskWithTarget = task as TaskSpec & { parallelTarget?: string; document?: string };
          const targetContent =
            (taskWithTarget.parallelTarget && taskWithTarget.parallelTarget.trim().length > 0)
              ? taskWithTarget.parallelTarget
              : (taskWithTarget.document && taskWithTarget.document.trim().length > 0)
                ? taskWithTarget.document
                : task.prompt;
          const cachedPrefix = routeSpec.buildPrefix({
            document: targetContent,
            preReadFiles,
            filePaths,
          });
          const shell = makeRunnerShell(provider);
          const dispatchResult = await dispatchParallelCriteria({
            shell,
            cachedPrefix,
            criteria: routeSpec.criteria,
            buildSuffix: routeSpec.buildSuffix,
            cwd: ctx.cwd,
            ...(ctx.stall.controller.signal && { abortSignal: ctx.stall.controller.signal }),
            deadlineMs: ctx.timing.deadlineMs,
            ...(ctx.bus && { bus: ctx.bus }),
            ...(ctx.batchId !== undefined && { batchId: ctx.batchId }),
            ...(ctx.taskIndex !== undefined && { taskIndex: ctx.taskIndex }),
            tier: decision.impl,
            route,
          });

          const totalCriteria = routeSpec.criteria.length;
          const succeededCount = dispatchResult.workerOutputs.length;
          const majorityThreshold = Math.ceil(totalCriteria / 2);
          const status: RunStatus = succeededCount === 0
            ? 'error'
            : succeededCount >= majorityThreshold ? 'ok' : 'incomplete';
          const incompleteReason = succeededCount > 0 && succeededCount < majorityThreshold
            ? ('missing_sections' as const)
            : undefined;
          const synthesizedOutput = dispatchResult.workerOutputs
            .map(o => `--- ${o.criterionTitle} (criterion ${o.criterionId}) ---\n${o.narrative}`)
            .join('\n\n');

          // Always set implementationReport so quality_review_round_1
           // (which gates on `last.implementationReport ?? last.structuredReport`)
           // fires even when the synthesized output contains no parseable
           // structured-report blocks. Non-empty workerOutputs is the
           // post-dispatch invariant that means "the implementer stage
           // produced something the annotator can merge."
          const parsedReport = parseStructuredReport(synthesizedOutput) ?? { findings: [], structuredReportSchemaUsed: 'fallback' as unknown as never };
          // terminationReason drives the wire envelope's terminalStatus
          // (event-builder.ts:359 deriveTerminalStatus reads tr.cause). Without
          // it, the rollup defaults to 'incomplete' even when status='ok'.
          const totalTurns = dispatchResult.workerOutputs.reduce((a, o) => a + o.turns, 0);
          const terminationCause: 'finished' | 'incomplete' | 'error' = succeededCount === 0
            ? 'error'
            : succeededCount >= majorityThreshold ? 'finished' : 'incomplete';
          const terminationReason = {
            cause: terminationCause,
            turnsUsed: totalTurns,
            hasFileArtifacts: false,
            usedShell: false,
            workerSelfAssessment: succeededCount === 0 ? 'failed' as const : 'done' as const,
            wasPromoted: false,
          };
          state.lastRunResult = {
            output: synthesizedOutput,
            status,
            usage: dispatchResult.totalUsage,
            turns: totalTurns,
            filesRead: filePaths,
            filesWritten: [],
            toolCalls: [],
            outputIsDiagnostic: false,
            escalationLog: [],
            parsedFindings: null,
            workerStatus: succeededCount === 0 ? 'failed' : 'done',
            terminationReason,
            workerOutputs: dispatchResult.workerOutputs.map(o => ({
              criterionId: o.criterionId,
              criterionTitle: o.criterionTitle,
              narrative: o.narrative,
            })),
            partialCriteriaCovered: dispatchResult.partialCriteriaCovered,
            partialCriteriaFailed: dispatchResult.partialCriteriaFailed,
            ...(incompleteReason && { incompleteReason }),
            implementationReport: parsedReport,
            structuredReport: parsedReport,
          } as unknown as RunResult;

          mergeStageStats(state, 'implementing', {
            inputTokens: dispatchResult.totalUsage.inputTokens,
            outputTokens: dispatchResult.totalUsage.outputTokens,
            cachedReadTokens: dispatchResult.totalUsage.cachedReadTokens,
            cachedNonReadTokens: dispatchResult.totalUsage.cachedNonReadTokens,
            turnCount: dispatchResult.workerOutputs.reduce((a, o) => a + o.turns, 0),
            toolCallCount: dispatchResult.workerOutputs.reduce((a, o) => a + o.toolCallCount, 0),
            costUSD: dispatchResult.workerOutputs.reduce((a, o) => a + (o.costUSD ?? 0), 0),
            durationMs: Math.max(0, ...dispatchResult.workerOutputs.map(o => o.durationMs)),
          }, {
            tier: ctx.assignedTier,
            model: (ctx.implementerProvider?.config as { model?: string } | undefined)?.model ?? null,
          });
          if (status !== 'ok') state.terminal = true;
          return undefined;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          state.lastRunResult = {
            output: '',
            status: 'error',
            usage: { inputTokens: 0, outputTokens: 0 },
            turns: 0,
            filesRead: [],
            filesWritten: [],
            toolCalls: [],
            outputIsDiagnostic: true,
            escalationLog: [],
            parsedFindings: null,
            error: message,
            errorCode: 'runner_crash',
            workerStatus: 'failed',
          } as unknown as RunResult;
          state.terminal = true;
          return undefined;
        }
      }

      try {
        const result = await delegateWithEscalation(
          {
            prompt: task.prompt,
            cwd: ctx.cwd,
            agentType: decision.impl,
            briefQualityPolicy: 'off',
            timeoutMs: ctx.timing.timeoutMs,
            ...(task.tools !== undefined && { tools: task.tools }),
          },
          [provider],
          {
            explicitlyPinned: false,
            taskDeadlineMs: ctx.timing.deadlineMs,
            abortSignal: ctx.stall.controller.signal,
            assignedTier: decision.impl,
            stageLabel: 'Implementing',
            ...(ctx.bus && { bus: ctx.bus }),
            ...(ctx.batchId !== undefined && { batchId: ctx.batchId }),
            taskIndex: ctx.taskIndex,
          },
        );
        const enrichedResult: RunResult = {
          ...result,
          ...(result.implementationReport === undefined && result.output && { implementationReport: parseStructuredReport(result.output) }),
        } as unknown as RunResult;
        state.lastRunResult = enrichedResult;
        // Record the implementer's per-stage cost so emit_task_terminal +
        // wire task.completed include it in the totals + per-stage breakdown.
        mergeStageStats(state, 'implementing', {
          inputTokens: result.usage.inputTokens ?? 0,
          outputTokens: result.usage.outputTokens ?? 0,
          cachedReadTokens: result.usage.cachedReadTokens ?? 0,
          cachedNonReadTokens: result.usage.cachedNonReadTokens ?? 0,
          turnCount: result.turns ?? 0,
          toolCallCount: Array.isArray(result.toolCalls) ? result.toolCalls.length : 0,
          costUSD: result.cost?.costUSD ?? null,
          durationMs: result.durationMs ?? null,
          filesReadCount: Array.isArray(result.filesRead) ? result.filesRead.length : 0,
          filesWrittenCount: Array.isArray(result.filesWritten) ? result.filesWritten.length : 0,
        }, {
          tier: ctx.assignedTier,
          model: (ctx.implementerProvider?.config as { model?: string } | undefined)?.model ?? null,
        });
        if (result.status !== 'ok') {
          state.terminal = true;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        state.lastRunResult = {
          output: '',
          status: 'error',
          usage: { inputTokens: 0, outputTokens: 0 },
          turns: 0,
          filesRead: [],
          filesWritten: [],
          toolCalls: [],
          outputIsDiagnostic: true,
          escalationLog: [],
          parsedFindings: null,
          error: message,
          errorCode: 'runner_crash',
          workerStatus: 'failed',
        } as unknown as RunResult;
        state.terminal = true;
      }
      return undefined;
    },
  });
  } finally {
    stopWatchdog();
  }

  const body = out.body;
  if (body && typeof body === 'object' && 'output' in body) {
    return body as RunResult;
  }
  return {
    output: '',
    status: 'error',
    usage: { inputTokens: 0, outputTokens: 0 },
    turns: 0,
    filesRead: [],
    filesWritten: [],
    toolCalls: [],
    outputIsDiagnostic: true,
    escalationLog: [],
    parsedFindings: null,
    error: 'dispatcher produced no RunResult',
    errorCode: 'runner_crash',
    workerStatus: 'failed',
  } as unknown as RunResult;
}
