import type {
  TaskSpec,
  RunResult,
  MultiModelConfig,
  Provider,
  AgentType,
} from '../types.js';
import type { ProgressEvent } from '../providers/runner-types.js';
import type { HeartbeatTickInfo } from '../bounded-execution/activity-tracker.js';
import type { HttpServerLog } from '../events/http-server-log.js';
import type { EventEmitter } from '../events/event-emitter.js';
import { runTaskViaDispatcher } from './dispatcher-bridge.js';

/**
 * #45 Step 7e: same-signature shim around runTaskViaDispatcher.
 *
 * `executeReviewedLifecycle` was the per-task entry point used by every
 * non-runTasks executor (investigate, audit, review, explore, verify, debug)
 * and by runTasks itself. Its signature is positional and load-bearing:
 * eight optional parameters in a specific order. This shim preserves that
 * exact signature so the import swap is mechanical.
 *
 * Internally it delegates to runTaskViaDispatcher, which constructs an
 * ExecutionContext from these per-task params and runs the StagePlan.
 *
 * Once `reviewed-lifecycle.ts` is deleted, this shim becomes the canonical
 * "run one task through the lifecycle" entry. Per-route executors keep
 * calling it; runTasks's per-task fan-out keeps calling it.
 */
export async function runReviewedTask(
  task: TaskSpec,
  resolved: { slot: AgentType; provider: Provider },
  config: MultiModelConfig,
  taskIndex: number,
  onProgress?: (taskIndex: number, event: ProgressEvent) => void,
  heartbeatWiring?: { batchId?: string; recordHeartbeat?: (tick: HeartbeatTickInfo) => void },
  diagnostics?: {
    logger?: HttpServerLog;
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
      mainModel: string | null;
      reviewPolicy?: 'full' | 'quality_only' | 'diff_only' | 'none';
      verifyCommandPresent?: boolean;
    }) => void;
  },
  route?: string,
  client?: string,
  triggeringSkill?: string,
  bus?: EventEmitter,
  qualityReviewPromptBuilder?: (ctx: { workerOutput: string; brief: string }) => string,
): Promise<RunResult> {
  return runTaskViaDispatcher({
    task,
    resolved,
    config,
    taskIndex,
    ...(onProgress && { onProgress }),
    ...(heartbeatWiring?.batchId !== undefined && { batchId: heartbeatWiring.batchId }),
    ...(heartbeatWiring?.recordHeartbeat && { recordHeartbeat: heartbeatWiring.recordHeartbeat }),
    ...(diagnostics?.logger && { logger: diagnostics.logger }),
    ...(diagnostics?.verbose !== undefined && { verbose: diagnostics.verbose }),
    ...(diagnostics?.verboseStream && { verboseStream: diagnostics.verboseStream }),
    ...(recorder && { recorder }),
    ...(route !== undefined && { route }),
    ...(client !== undefined && { client }),
    ...(triggeringSkill !== undefined && { triggeringSkill }),
    ...(bus && { bus }),
    ...(qualityReviewPromptBuilder && { qualityReviewPromptBuilder }),
  });
}
