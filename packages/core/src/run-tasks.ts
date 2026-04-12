import type {
  Provider,
  RunResult,
  TaskSpec,
  MultiModelConfig,
  ProgressEvent,
  RunTasksRuntime,
  AgentType,
  AgentCapability,
} from './types.js';
import { createProvider } from './provider.js';
import { resolveAgent } from './routing/resolve-agent.js';
import { delegateWithEscalation } from './delegate-with-escalation.js';
import { expandContextBlocks } from './context/expand-context-blocks.js';

export type RunTasksProgressCallback = (
  taskIndex: number,
  event: ProgressEvent,
) => void;

export interface RunTasksOptions {
  onProgress?: RunTasksProgressCallback;
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
    outputIsDiagnostic: true,
    escalationLog: [],
    error,
  };
}

type ResolvedTask =
  | { task: TaskSpec; resolved: { slot: AgentType; provider: Provider; capabilityOverride: boolean } }
  | { task: TaskSpec; error: string; errorCode: string };

async function executeTask(
  resolved: Exclude<ResolvedTask, { error: string }>,
  onProgress?: (event: ProgressEvent) => void,
): Promise<RunResult> {
  try {
    return await delegateWithEscalation(
      resolved.task,
      [resolved.resolved.provider],
      { explicitlyPinned: true, onProgress },
    );
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
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
      const resolved_agent = resolveAgent(
        agentType,
        (task.requiredCapabilities ?? []) as AgentCapability[],
        config,
      );
      return { task, resolved: resolved_agent };
    } catch (err) {
      return {
        task,
        error: err instanceof Error ? err.message : String(err),
        errorCode: 'capability_missing',
      };
    }
  });

  return Promise.all(
    resolved.map((r, index): Promise<RunResult> => {
      if ('error' in r) {
        return Promise.resolve(errorResult(r.error));
      }
      const taskProgress = options.onProgress
        ? (event: ProgressEvent) => options.onProgress!(index, event)
        : undefined;
      return executeTask(r, taskProgress);
    }),
  );
}
