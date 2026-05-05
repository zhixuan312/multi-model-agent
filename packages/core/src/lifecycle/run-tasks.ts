import type {
  RunResult,
  TaskSpec,
  MultiModelConfig,
  AgentType,
} from '../types.js';
import type { ProgressEvent, RunTasksRuntime } from '../runners/types.js';
import type { HeartbeatTickInfo } from '../heartbeat.js';
import type { HttpServerLog } from '../diagnostics/http-server-log.js';
import type { EventBus } from '../observability/bus.js';
import { resolveAgent } from '../routing/resolve-agent.js';
import { expandContextBlocks } from '../context/expand-context-blocks.js';
import { executeReviewedLifecycle } from './reviewed-lifecycle.js';
import { errorResult } from './execute-task.js';
import type { ResolvedTask } from './execute-task.js';

export type RunTasksProgressCallback = (
  taskIndex: number,
  event: ProgressEvent,
) => void;

export interface RunTasksOptions {
  onProgress?: RunTasksProgressCallback;
  runtime?: RunTasksRuntime;
  /** Batch ID this run belongs to; threaded to HeartbeatTimer when set. */
  batchId?: string;
  /** Callback fired on every heartbeat tick with a state snapshot. */
  recordHeartbeat?: (tick: HeartbeatTickInfo) => void;
  /**
   * Optional HttpServerLog. When present AND `verbose` is true, the
   * runner records per-tool-call + per-LLM-turn events for post-mortem
   * diagnosis of slow tasks. Logger writes are a no-op if diagnostics.log=false,
   * so passing it is always safe.
   */
  logger?: HttpServerLog;
  /**
   * Enable verbose emissions. When true, each tool call and LLM turn is
   * streamed to `verboseStream` (default: process.stderr) so the operator
   * sees the server's work live. Orthogonal to `diagnostics.log` — you
   * can have live streaming without persisting a JSONL file.
   */
  verbose?: boolean;
  /** Injectable stream target for verbose output. Defaults to process.stderr. */
  verboseStream?: (line: string) => void;
  /** Telemetry recorder — fire-and-forget, failures are silently dropped. */
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
  /** Route name for telemetry (e.g. 'delegate', 'audit'). */
  route?: string;
  /** Client identifier for telemetry (e.g. 'claude-code', 'cursor'). */
  client?: string;
  /** Triggering skill for telemetry (e.g. 'mma-delegate', 'direct'). */
  triggeringSkill?: string;
  /** EventBus for structured observability events. */
  bus?: EventBus;
  /** Per-route quality review prompt builder (for quality_only reviewPolicy). */
  qualityReviewPromptBuilder?: (ctx: { workerOutput: string; brief: string }) => string;
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
      return executeReviewedLifecycle(r.task, r.resolved, config, index, options.onProgress, {
        batchId: options.batchId,
        recordHeartbeat: options.recordHeartbeat,
      }, {
        logger: options.logger,
        verbose: options.verbose ?? config.diagnostics?.verbose ?? false,
        verboseStream: options.verboseStream,
      }, options.recorder, options.route, options.client, options.triggeringSkill, options.bus, options.qualityReviewPromptBuilder);
    }),
  );
}

export { extractPlanSection } from './plan-extraction.js';
