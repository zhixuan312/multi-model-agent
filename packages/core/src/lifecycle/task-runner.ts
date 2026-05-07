import type {
  TaskSpec,
  RunResult,
  MultiModelConfig,
  Provider,
  AgentType,
} from '../types.js';
import type { ProgressEvent, RunTasksRuntime } from '../providers/runner-types.js';
import type { HeartbeatTickInfo } from '../bounded-execution/activity-tracker.js';
import type { HttpServerLog } from '../events/http-server-log.js';
import type { EventEmitter } from '../events/event-emitter.js';
import type { ExecutionContext } from './lifecycle-context.js';
import type { LifecycleState } from './stage-plan-types.js';
import type { ResolvedAgent } from '../escalation/agent-resolver.js';
import { LifecycleDispatcher } from './lifecycle-dispatcher.js';
import { createDefaultReviewerEngine, createDefaultAnnotatorEngine } from '../review/default-engines.js';
import { ATTEMPT_BUDGETS, type ToolCategory } from '../escalation/escalation-policy.js';
import { pickEscalation } from '../escalation/policy.js';
import { resolveAgent } from '../escalation/agent-resolver.js';
import { expandContextBlocks } from '../stores/expand-context-blocks.js';
import { delegateWithEscalation } from '../escalation/delegate-with-escalation.js';
import { parseStructuredReport } from '../reporting/structured-report.js';
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
      triggeringSkill: string;
      mainModel: string | null;
      reviewPolicy?: 'full' | 'quality_only' | 'diff_only' | 'none';
      verifyCommandPresent?: boolean;
    }) => void;
  };
  route?: string;
  client?: string;
  triggeringSkill?: string;
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
        ...(options.triggeringSkill !== undefined && { triggeringSkill: options.triggeringSkill }),
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
  triggeringSkill?: string;
  bus?: EventEmitter;
  qualityReviewPromptBuilder?: (ctx: { workerOutput: string; brief: string }) => string;
  reviewerEngine?: import('../review/reviewer-engine.js').ReviewerEngine;
  annotatorEngine?: import('../review/annotator-engine.js').AnnotatorEngine;
}

function toolCategoryForRoute(route: string | undefined): ToolCategory {
  if (route === 'investigate' || route === 'review' || route === 'audit' || route === 'debug' || route === 'verify') return 'read_only';
  if (route === 'explore') return 'research';
  if (route === 'register-context-block') return 'assist';
  return 'artifact_producing';
}

function buildExecutionContext(input: DispatchTaskInput): ExecutionContext {
  const { task, resolved, config } = input;
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
    triggeringSkill: input.triggeringSkill ?? '',
    mainModel: input.recorder ? null : null,
    assignedTier: resolved.slot,
    implementerProvider: resolved.provider,
    escalationProvider: providers[resolved.slot === 'standard' ? 'complex' : 'standard'],
    providers,
    implementerIdentity: undefined,
    timing: { startMs, timeoutMs, deadlineMs: startMs + timeoutMs, stallTimeoutMs },
    budgets: { maxCostUSD: task.maxCostUSD ?? config.defaults?.maxCostUSD },
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
  const executionContext = buildExecutionContext(input);
  const route = input.route ?? '';
  const toolCategory = toolCategoryForRoute(route);

  void ATTEMPT_BUDGETS[toolCategory];

  const out = await dispatcher.dispatch({
    route,
    toolCategory,
    rawRequest: { tasks: [input.task] },
    context: { task: input.task, executionContext },
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
          },
        );
        const enrichedResult: RunResult = {
          ...result,
          ...(result.implementationReport === undefined && result.output && { implementationReport: parseStructuredReport(result.output) }),
        } as unknown as RunResult;
        state.lastRunResult = enrichedResult;
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
