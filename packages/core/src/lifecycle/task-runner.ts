import type {
  TaskSpec,
  RuntimeRunResult,
  MultiModelConfig,
  Provider,
  AgentType,
} from '../types.js';
import type { ProgressEvent, RunTasksRuntime } from '../providers/runner-types.js';
import type { Session } from '../types/run-result.js';
import type { HeartbeatTickInfo } from '../bounded-execution/activity-tracker.js';
import type { HttpServerLog } from '../events/http-server-log.js';
import type { EventEmitter } from '../events/event-emitter.js';
import type { ExecutionContext } from './lifecycle-context.js';
import type { LifecycleState } from './stage-plan-types.js';
import type { ResolvedAgent } from '../providers/agent-resolver.js';
import { LifecycleDispatcher } from './lifecycle-dispatcher.js';
import { WallClockGuard } from '../bounded-execution/wall-clock-guard.js';
import { ActivityTracker } from '../bounded-execution/activity-tracker.js';
import { ATTEMPT_BUDGETS, type ToolCategory } from './rework-budget.js';
import { resolveAgent } from '../providers/agent-resolver.js';
import { expandContextBlocks } from '../stores/expand-context-blocks.js';
import { startStallWatchdog } from '../bounded-execution/stall-watchdog.js';
import { startProgressEventsSubscriber } from '../bounded-execution/progress-events-subscriber.js';
import { normalizeOutputTargets } from './normalize-output-targets.js';
export function errorResult(error: string): RuntimeRunResult {
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
    error,
    actualCostUSD: 0,
    directoriesListed: [],
  };
}

const PARALLEL_SAFETY_SUFFIX =
  '\n\nYou are running in parallel with other tasks. ' +
  'Do NOT run full-project build commands (`npm run build`, `tsc`, `cargo build`). ' +
  'Only run task-specific test commands if provided.';

/**
 * Conditionally appends PARALLEL_SAFETY_SUFFIX to each task's prompt.
 * Suffix is appended ONLY when ctx.batchGroupCount > 1, i.e., the batch
 * spans multiple repos. Within a single group, tasks run serially and
 * full builds are safe.
 *
 * Pure function — returns shallow-cloned tasks; original array unchanged.
 */
export function applyParallelSafetySuffixIfNeeded<T extends { prompt: string; testCommand?: string }>(
  tasks: T[],
  ctx: { batchGroupCount?: number },
): T[] {
  if (!ctx.batchGroupCount || ctx.batchGroupCount <= 1) return tasks.slice();
  return tasks.map((t) => ({
    ...t,
    prompt: t.prompt + PARALLEL_SAFETY_SUFFIX +
      (t.testCommand ? `\nTo verify your work, run: \`${t.testCommand}\`` : ''),
  }));
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
      runResult: RuntimeRunResult;
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
  batchGroupCount?: number;
}

export async function runTasks(
  tasks: TaskSpec[],
  config: MultiModelConfig,
  options: RunTasksOptions = {},
): Promise<RuntimeRunResult[]> {
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

  const tasksWithSuffix = applyParallelSafetySuffixIfNeeded(
    resolved.filter((r): r is Exclude<typeof r, { error: string }> => !('error' in r)).map((r) => r.task),
    { batchGroupCount: options.batchGroupCount },
  );
  // Reattach mutated tasks back to resolved entries.
  let suffixIdx = 0;
  for (const r of resolved) {
    if ('error' in r) continue;
    r.task = tasksWithSuffix[suffixIdx++]!;
  }

  return Promise.all(
    resolved.map((r, index): Promise<RuntimeRunResult> => {
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
        verbose: true,
        ...(options.verboseStream && { verboseStream: options.verboseStream }),
        ...(options.recorder && { recorder: options.recorder }),
        ...(options.route !== undefined && { route: options.route }),
        ...(options.client !== undefined && { client: options.client }),
        ...(options.bus && { bus: options.bus }),
        ...(options.qualityReviewPromptBuilder && { qualityReviewPromptBuilder: options.qualityReviewPromptBuilder }),
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
  /** Registry to attach/detach the per-task ExecutionContext on. When provided,
   *  shutdown drain in serve.ts can walk the registry and call closeSessions()
   *  on every in-flight task before the daemon exits. */
  batchRegistry?: import('../stores/batch-registry.js').BatchRegistry;
}

function toolCategoryForRoute(route: string | undefined): ToolCategory {
  if (route === 'investigate' || route === 'review' || route === 'audit' || route === 'debug' || route === 'research') return 'read_only';
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

  const startMsAt = startMs;
  const deadlineAt = startMs + timeoutMs;
  const stallController = new AbortController();

  // Lazy session cache keyed by tier. Construction is deferred until the
  // first getSession(tier) call so a task that only uses one tier doesn't
  // open a session on the other (and thus doesn't spawn a codex CLI or
  // initialize a claude SDK query). Cleanup happens via closeSessions(),
  // invoked by runTaskViaDispatcher's finally block.
  const sessions = new Map<AgentType, Session>();
  const getSession = (tier: AgentType): Session => {
    const existing = sessions.get(tier);
    if (existing) return existing;
    const provider = providers[tier];
    if (!provider) {
      throw new Error(`getSession: no provider configured for tier "${tier}"`);
    }
    const session = provider.openSession({
      cwd,
      wallClockDeadline: deadlineAt,
      idleStallTimeoutMs: stallTimeoutMs,
      abortSignal: stallController.signal,
      ...(input.bus && { bus: input.bus as unknown as object }),
      ...(input.batchId !== undefined && { batchId: input.batchId }),
      ...(input.taskIndex !== undefined && { taskIndex: input.taskIndex }),
    });
    sessions.set(tier, session);
    return session;
  };
  const closeSessions = async (): Promise<void> => {
    const entries = Array.from(sessions.entries());
    sessions.clear();
    await Promise.allSettled(entries.map(([, s]) => s.close()));
  };
  const getActivePids = (): number[] => {
    const pids: number[] = [];
    for (const sess of sessions.values()) {
      const pid = sess.getPid?.();
      if (typeof pid === 'number' && pid > 0) pids.push(pid);
    }
    return pids;
  };

  const heartbeat = input.recordHeartbeat
    ? new ActivityTracker(
        // onProgress: internal-only tick hook. The recordHeartbeat callback
        // (passed via options) is the canonical channel for headline updates.
        // We deliberately do NOT forward ticks to the observability bus —
        // the tick shape (kind: 'heartbeat') does not conform to the bus
        // event schema (event: 'heartbeat') and is not part of the JSONL
        // contract consumed by telemetry/observability sinks.
        () => { /* no-op */ },
        {
          provider: resolved.provider.name,
          ...(input.mainModel && { mainModel: input.mainModel }),
          intervalMs: 5000,
          recordHeartbeat: input.recordHeartbeat,
          ...(input.batchId !== undefined && { batchId: input.batchId }),
        },
      )
    : undefined;

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
    getSession,
    closeSessions,
    getActivePids,
    timing: { startMs: startMsAt, timeoutMs, deadlineMs: deadlineAt, stallTimeoutMs },
    wallClockGuard: new WallClockGuard(timeoutMs),
    stall: { controller: stallController, lastEventAtMs: startMsAt, fired: false },
    implementerToolMode: task.tools,
    ...(input.qualityReviewPromptBuilder && { qualityReviewPromptBuilder: input.qualityReviewPromptBuilder }),
    bus: input.bus,
    heartbeat,
    logger: input.logger,
    verboseStream: input.verboseStream ?? ((line: string) => { process.stderr.write(line); }),
    verbose: true,
    ...(input.recordHeartbeat && { recordHeartbeat: input.recordHeartbeat }),
    ...(input.recorder && { recorder: input.recorder }),
    outputTargets: normalizeOutputTargets(task.outputTargets, cwd),
  };
}

export async function runTaskViaDispatcher(
  input: DispatchTaskInput,
  dispatcher: LifecycleDispatcher = new LifecycleDispatcher(),
): Promise<RuntimeRunResult> {
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

  // Register this task's ExecutionContext on the BatchRegistry so shutdown
  // drain (serve.ts cleanupSignal) can find every in-flight task and call
  // closeSessions() on it before the daemon exits. Detached in finally{}.
  if (input.batchRegistry && input.batchId !== undefined) {
    input.batchRegistry.attachExecutionContext(input.batchId, input.taskIndex, executionContext);
  }

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

  executionContext.heartbeat?.start(1);

  const stopProgressEvents = (executionContext.heartbeat && executionContext.bus)
    ? startProgressEventsSubscriber({
        bus: executionContext.bus,
        tracker: executionContext.heartbeat,
        ...(executionContext.batchId !== undefined && { batchId: executionContext.batchId }),
        ...(executionContext.taskIndex !== undefined && { taskIndex: executionContext.taskIndex }),
      })
    : () => { /* no-op disposer */ };

  let out;
  try {
    try {
      out = await dispatcher.dispatch({
        route,
        toolCategory,
        rawRequest: { tasks: [expandedTask] },
        context: { task: expandedTask, executionContext },
      });
    } finally {
      stopWatchdog();
      stopProgressEvents();
      // v4.4 session reuse: ExecutionContext owns the per-tier Session
      // cache that handlers populate via ctx.getSession(tier). Close them
      // here at task end so codex CLI subprocesses + claude-agent-sdk
      // query handles release. Errors swallowed so disposal can't mask
      // the task's real result.
      await executionContext.closeSessions().catch(() => { /* idempotent */ });
      // Detach from BatchRegistry — closeSessions already ran, so shutdown
      // drain shouldn't re-close.
      if (input.batchRegistry && input.batchId !== undefined) {
        input.batchRegistry.detachExecutionContext(input.batchId, input.taskIndex);
      }
    }

    // v5: dispatcher.dispatch returns ComposePayload as `body` and the full
    // LifecycleState as `finalState`. The runtime mirror (RuntimeRunResult
    // with workerStatus / stageStats / usage etc.) lives on
    // finalState.lastRunResult — populated by performImplementation.
    // Downstream consumers (executeTask, recorder, headline composer) still
    // expect the runtime mirror, so return it directly.
    const last = out.finalState?.lastRunResult as RuntimeRunResult | undefined;
    if (last && typeof last === 'object' && 'output' in last) {
      return last;
    }
    const body = out.body;
    if (body && typeof body === 'object' && 'output' in body) {
      return body as RuntimeRunResult;
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
      error: 'dispatcher produced no RuntimeRunResult',
      errorCode: 'runner_crash',
      workerStatus: 'failed',
    } as unknown as RuntimeRunResult;
  } finally {
    executionContext.heartbeat?.stop();
  }
}
