import type {
  Provider,
  RunResult,
  TaskSpec,
  MultiModelConfig,
  ProgressEvent,
  RunTasksRuntime,
  AgentType,
  AgentCapability,
  BriefQualityWarning,
} from './types.js';
import { createProvider } from './provider.js';
import { resolveAgent } from './routing/resolve-agent.js';
import { delegateWithEscalation } from './delegate-with-escalation.js';
import { expandContextBlocks } from './context/expand-context-blocks.js';
import { evaluateReadiness } from './readiness/readiness.js';
import { normalizeBrief } from './readiness/normalize-brief.js';

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

  const readinessResults = expandedTasks.map((entry) => {
    if ('error' in entry) return undefined;
    const task = entry as TaskSpec;
    if (task.briefQualityPolicy === undefined) return undefined;
    return evaluateReadiness(task, task.briefQualityPolicy);
  });

  const refusedResults = expandedTasks.map((entry, idx) => {
    if ('error' in entry) return undefined;
    const readiness = readinessResults[idx];
    if (!readiness) return undefined;
    if (readiness.action === 'refuse') {
      return {
        output: `Brief too vague: missing ${readiness.missingPillars.join(', ')}`,
        status: 'brief_too_vague' as const,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: null },
        turns: 0,
        filesRead: [] as string[],
        filesWritten: [] as string[],
        toolCalls: [] as string[],
        outputIsDiagnostic: true,
        escalationLog: [] as RunResult['escalationLog'],
        errorCode: 'brief_too_vague',
        briefQualityWarnings: readiness.briefQualityWarnings as BriefQualityWarning[],
        retryable: false,
      };
    }
    return undefined;
  });

  const normalizationResults = await Promise.all(
    expandedTasks.map(async (entry, idx) => {
      if ('error' in entry) return undefined;
      const readiness = readinessResults[idx];
      if (!readiness || readiness.action !== 'normalize') return undefined;
      return await normalizeBrief(entry as TaskSpec, config);
    }),
  );

  const effectiveTasks: (TaskSpec | { error: string })[] = expandedTasks.map((entry, idx) => {
    if ('error' in entry) return entry;
    const norm = normalizationResults[idx];
    if (norm && !norm.skipped) {
      return { ...(entry as TaskSpec), prompt: norm.normalizedPrompt };
    }
    return entry;
  });

  const resolved: ResolvedTask[] = effectiveTasks.map((entry, idx): ResolvedTask => {
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
        return Promise.resolve({ ...errorResult(r.error), errorCode: r.errorCode });
      }
      const refused = refusedResults[index];
      if (refused) {
        return Promise.resolve(refused);
      }
      const taskProgress = options.onProgress
        ? (event: ProgressEvent) => options.onProgress!(index, event)
        : undefined;
      return executeTask(r, taskProgress);
    }),
  );
}
