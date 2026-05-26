import type {
  TaskSpec,
  RuntimeRunResult,
  MultiModelConfig,
  Provider,
  AgentType,
} from '../types.js';
import type { ProgressEvent } from '../providers/runner-types.js';
import type { Session, ResolvedSkillBundle } from '../types/run-result.js';
import type { HeartbeatTickInfo } from '../bounded-execution/activity-tracker.js';
import { resolveAndStageSkills, cleanupSkillStaging, SkillResolutionError } from '../providers/skill-resolver.js';

import type { EnvelopeBus } from '../events/envelope-bus.js';
import type { ExecutionContext } from './lifecycle-context.js';
import type { LifecycleState } from './stage-plan-types.js';
import type { ResolvedAgent } from '../providers/agent-resolver.js';
import { LifecycleDispatcher } from './lifecycle-dispatcher.js';
import { WallClockGuard } from '../bounded-execution/wall-clock-guard.js';
import { ActivityTracker } from '../bounded-execution/activity-tracker.js';
import type { ToolCategory } from './tool-category.js';
import { resolveAgent } from '../providers/agent-resolver.js';
import { releaseTask } from '../providers/provider-factory.js';
import { expandContextBlocks } from '../stores/expand-context-blocks.js';
import { startStallWatchdog } from '../bounded-execution/stall-watchdog.js';
import { startProgressEventsSubscriber } from '../bounded-execution/progress-events-subscriber.js';
import { normalizeOutputTargets } from './normalize-output-targets.js';

const PARALLEL_SAFETY_SUFFIX =
  '\n\nYou are running in parallel with other tasks. ' +
  'Do NOT run full-project build commands (`npm run build`, `tsc`, `cargo build`). ' +
  'Only run task-specific test commands if provided.';

/**
 * Conditionally appends PARALLEL_SAFETY_SUFFIX to each task's prompt.
 * Appended ONLY when `concurrent` is true — i.e. the batch runs in parallel
 * mode with more than one task. Within serial dispatch (or single-task
 * batches) tasks don't race, so the reminder is omitted. The suffix
 * reinforces per-worker commit attribution: stay in your lane, touch only
 * your own files.
 *
 * Pure function — returns shallow-cloned tasks; original array unchanged.
 */
export function applyParallelSafetySuffixIfNeeded<T extends { prompt: string; testCommand?: string }>(
  tasks: T[],
  concurrent: boolean,
): T[] {
  if (!concurrent) return tasks.slice();
  return tasks.map((t) => ({
    ...t,
    prompt: t.prompt + PARALLEL_SAFETY_SUFFIX +
      (t.testCommand ? `\nTo verify your work, run: \`${t.testCommand}\`` : ''),
  }));
}

export interface DispatchTaskInput {
  task: TaskSpec;
  resolved: ResolvedAgent;
  config: MultiModelConfig;
  taskIndex: number;
  onProgress?: (taskIndex: number, event: ProgressEvent) => void;
  batchId?: string;
  recordHeartbeat?: (tick: HeartbeatTickInfo) => void;
  logger?: { error: (kind: string, err: unknown) => void };
  recorder?: ExecutionContext['recorder'];
  route?: string;
  client?: string;
  /** Calling agent's model (e.g., claude-opus-4-7), threaded into telemetry as mainModel.
   *  Sourced from X-MMA-Main-Model header → execution-context → here. */
  mainModel?: string | null;
  bus?: EnvelopeBus;
  /** Context block store for expanding contextBlockIds into the task's prompt
   *  before dispatch. Without this, the worker LLM never sees the prior-round
   *  audit/review report referenced by contextBlockIds. */
  contextBlockStore?: import('../stores/context-block-tool.js').ContextBlockStore;
  /** Registry to attach/detach the per-task ExecutionContext on. When provided,
   *  shutdown drain in serve.ts can walk the registry and call closeSessions()
   *  on every in-flight task before the daemon exits. */
  batchRegistry?: import('../stores/batch-registry.js').BatchRegistry;
  /** Per-task event envelope for recording lifecycle mutations. Optional during migration. */
  envelope?: import('../events/task-envelope.js').TaskEnvelopeStore;
  resolvedSkills?: ResolvedSkillBundle;
}

function toolCategoryForRoute(route: string | undefined): ToolCategory {
  if (route === 'investigate' || route === 'review' || route === 'audit' || route === 'debug' || route === 'research' || route === 'journal-recall') return 'read_only';
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
      ...(input.envelope && { envelope: input.envelope }),
      ...(input.batchId !== undefined && { batchId: input.batchId }),
      ...(input.taskIndex !== undefined && { taskIndex: input.taskIndex }),
      ...(input.resolvedSkills && { skills: input.resolvedSkills }),
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
    // Thread the BatchRegistry onto the lifecycle ctx so the terminal stage can
    // register the read-route terminal context block (recordTerminalBlock keys
    // by batchId/taskIndex). Without this, registerTerminalBlockHandler's guard
    // returns early and contextBlockId is silently null on read routes.
    ...(input.batchRegistry && { batchRegistry: input.batchRegistry }),
    assignedTier: resolved.slot,
    implementerProvider: resolved.provider,
    providers,
    getSession,
    closeSessions,
    getActivePids,
    timing: { startMs: startMsAt, timeoutMs, deadlineMs: deadlineAt, stallTimeoutMs },
    wallClockGuard: new WallClockGuard(timeoutMs),
    stall: { controller: stallController, lastEventAtMs: startMsAt, fired: false },
    implementerToolMode: task.tools,
    bus: input.bus,
    heartbeat,
    logger: input.logger,
    ...(input.recordHeartbeat && { recordHeartbeat: input.recordHeartbeat }),
    ...(input.recorder && { recorder: input.recorder }),
    outputTargets: normalizeOutputTargets(task.outputTargets, cwd),
    ...(input.envelope && { envelope: input.envelope }),
  } as unknown as ExecutionContext;
}

export async function resolveSkillsForTask(args: {
  task: { prompt: string; skills?: string[] };
  client: string;
  batchId: string;
  taskIndex: number;
}): Promise<{ bundle?: ResolvedSkillBundle; failure?: RuntimeRunResult }> {
  const names = args.task.skills;
  if (!names || names.length === 0) return {};
  try {
    const bundle = await resolveAndStageSkills({
      client: args.client, names, batchId: args.batchId, taskIndex: args.taskIndex,
    });
    return { bundle };
  } catch (err) {
    if (err instanceof SkillResolutionError) {
      // Shape mirrors the existing "dispatcher produced no RuntimeRunResult"
      // fallback literal at the bottom of runTaskViaDispatcher in this same
      // file — include the required RuntimeRunResult fields (actualCostUSD,
      // directoriesListed) so the cast is faithful, not just compiler-silencing.
      return {
        failure: {
          output: '',
          status: 'error',
          usage: { inputTokens: 0, outputTokens: 0 },
          actualCostUSD: 0,
          turns: 0,
          filesWritten: [],
          directoriesListed: [],
          outputIsDiagnostic: true,
          escalationLog: [],
          error: err.message,
          errorCode: err.code,
          workerStatus: 'failed',
        } as unknown as RuntimeRunResult,
      };
    }
    throw err;
  }
}

export async function runTaskViaDispatcher(
  input: DispatchTaskInput,
  dispatcher: LifecycleDispatcher = new LifecycleDispatcher(),
): Promise<RuntimeRunResult> {
  const skillResolution = await resolveSkillsForTask({
    task: input.task as { prompt: string; skills?: string[] },
    client: input.client ?? '',
    batchId: String(input.batchId ?? 'nobatch'),
    taskIndex: input.taskIndex,
  });
  if (skillResolution.failure) return skillResolution.failure;

  // Gap 1 fix: expand contextBlockIds into the task's prompt once, up-front,
  // so the SAME expanded task object reaches BOTH state.task AND
  // executionContext.task (single source of truth — no two references).
  // buildExecutionContext also expands internally, but that becomes a no-op
  // because expandContextBlocks strips contextBlockIds on first pass.
  const expandedTask = input.contextBlockStore
    ? expandContextBlocks(input.task, input.contextBlockStore)
    : input.task;

  const executionContext = buildExecutionContext({
    ...input,
    task: expandedTask,
    ...(skillResolution.bundle && { resolvedSkills: skillResolution.bundle }),
  });
  const route = input.route ?? '';
  const toolCategory = toolCategoryForRoute(route);

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
    ...(executionContext.envelope && { envelope: executionContext.envelope }),
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
      if (skillResolution.bundle) {
        await cleanupSkillStaging(skillResolution.bundle.stagedRoot).catch(() => { /* best-effort */ });
      }
      // Detach from BatchRegistry — closeSessions already ran, so shutdown
      // drain shouldn't re-close.
      if (input.batchRegistry && input.batchId !== undefined) {
        input.batchRegistry.detachExecutionContext(input.batchId, input.taskIndex);
      }
      // Safety net: force-close any sessions that escaped normal close path.
      // Per-task safety ceiling (D6) requires explicit release on task termination.
      if (input.batchId !== undefined) {
        const bus = input.bus as unknown as { emit?: (e: Record<string, unknown>) => void } | undefined;
        await releaseTask(input.batchId, input.taskIndex, bus);
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
      filesWritten: [],
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
