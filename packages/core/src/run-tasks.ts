import type {
  Provider,
  RunResult,
  TaskSpec,
  MultiModelConfig,
  ProgressEvent,
  RunTasksRuntime,
} from './types.js';
import { createProvider } from './provider.js';
import { getProviderEligibility } from './routing/get-provider-eligibility.js';
import { selectProviderForTask } from './routing/select-provider-for-task.js';
import { buildEscalationChain, delegateWithEscalation } from './delegate-with-escalation.js';
import { expandContextBlocks } from './context/expand-context-blocks.js';

/**
 * Per-task progress sink. `runTasks` invokes this for every
 * `ProgressEvent` emitted while working on task at `taskIndex`. The caller
 * (today: the MCP cli bridge) is responsible for disambiguating which task
 * emitted which event — this is the cheapest contract: the orchestrator
 * already knows each task's position in the input array, so the caller
 * doesn't have to wrap N closures.
 */
export type RunTasksProgressCallback = (
  taskIndex: number,
  event: ProgressEvent,
) => void;

export interface RunTasksOptions {
  /** Optional progress sink. See `RunTasksProgressCallback`. When omitted,
   *  no progress events are produced — backward-compatible with callers
   *  that predate Task 8. */
  onProgress?: RunTasksProgressCallback;
  /** Runtime dependencies the orchestrator needs at dispatch time. Today
   *  this is just the context-block store used to expand
   *  `TaskSpec.contextBlockIds`. Kept as a nested field so existing callers
   *  that only pass `onProgress` don't break. */
  runtime?: RunTasksRuntime;
}

function errorResult(error: string): RunResult {
  return {
    output: `Sub-agent error: ${error}`,
    status: 'error',
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: null },
    turns: 0,
    filesRead: [],
    filesWritten: [],
    toolCalls: [],
    escalationLog: [],
    error,
  };
}

type ResolvedTask =
  | { task: TaskSpec; pinned: true; provider: Provider }
  | { task: TaskSpec; pinned: false }
  | { task: TaskSpec; error: string } // routing/eligibility failure

async function executeTask(
  resolved: Exclude<ResolvedTask, { error: string }>,
  config: MultiModelConfig,
  onProgress?: (event: ProgressEvent) => void,
): Promise<RunResult> {
  try {
    if (resolved.pinned) {
      // Explicit pin: chain of length 1, no escalation.
      return await delegateWithEscalation(
        resolved.task,
        [resolved.provider],
        { explicitlyPinned: true, onProgress },
      );
    }
    // Auto-routed: walk all eligible providers cheapest-first.
    const chain = buildEscalationChain(resolved.task, config);
    if (chain.length === 0) {
      // Defensive: selectProviderForTask succeeded earlier so eligibility
      // existed at resolution time. If the chain is somehow empty now we
      // surface a structured error rather than throwing.
      return errorResult('No eligible provider found for task at dispatch time.');
    }
    return await delegateWithEscalation(resolved.task, chain, { onProgress });
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Run tasks concurrently. Each RunResult corresponds to the matching TaskSpec
 * at the same index. One task failing does not affect others.
 *
 * When `options.onProgress` is supplied, it is called with `(taskIndex, event)`
 * for every progress event emitted by that task's provider run or the
 * escalation orchestrator. See `ProgressEvent` for variants.
 */
export async function runTasks(
  tasks: TaskSpec[],
  config: MultiModelConfig,
  options: RunTasksOptions = {},
): Promise<RunResult[]> {
  if (tasks.length === 0) return [];

  // Expand context blocks up-front so the rest of the pipeline sees a
  // self-contained prompt. `expandContextBlocks` is a no-op for tasks
  // without `contextBlockIds` and for calls that omit `runtime`, so
  // existing callers are unaffected. A missing block id throws
  // `ContextBlockNotFoundError` synchronously — we convert it to an
  // error-result for the specific task so the rest of the batch still
  // runs.
  const expandedTasks: (TaskSpec | { error: string })[] = tasks.map((task) => {
    try {
      return expandContextBlocks(task, options.runtime?.contextBlockStore);
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  const resolved: ResolvedTask[] = expandedTasks.map((entry, idx): ResolvedTask => {
    if ('error' in entry) {
      return { task: tasks[idx], error: entry.error };
    }
    const task = entry;
    // If provider specified, validate and use it
    if (task.provider) {
      const eligibility = getProviderEligibility(task, config);
      const report = eligibility.find((e) => e.name === task.provider);
      if (!report) {
        // Provider explicitly named but not in config — fail fast with error result
        return {
          task,
          error: `Provider "${task.provider}" not found in config.`,
        };
      }
      if (!report.eligible) {
        const reasons = report.reasons.map((r) => r.message).join('; ');
        return {
          task,
          error: `Provider "${task.provider}" is ineligible: ${reasons}`,
        };
      }
      return {
        task,
        pinned: true,
        provider: createProvider(task.provider, config),
      };
    }

    // Auto-routing — selectProviderForTask is still used here so the "no
    // eligible provider" error path stays identical to pre-escalation
    // behavior. The actual chain is constructed inside executeTask.
    const selected = selectProviderForTask(task, config);
    if (!selected) {
      const available = Object.keys(config.providers);
      return {
        task,
        error: `No eligible provider found for task (required tier: ${task.tier}, capabilities: ${task.requiredCapabilities.join(', ') || 'none'}). Available providers: ${available.join(', ') || 'none'}.`,
      };
    }
    return { task, pinned: false };
  });

  return Promise.all(
    resolved.map((r, index): Promise<RunResult> => {
      if ('error' in r) {
        return Promise.resolve(errorResult(r.error));
      }
      // Bind the task index into a per-task sink so the caller can
      // disambiguate which task an event belongs to without threading
      // extra fields through the orchestrator.
      const taskProgress = options.onProgress
        ? (event: ProgressEvent) => options.onProgress!(index, event)
        : undefined;
      return executeTask(r, config, taskProgress);
    }),
  );
}
