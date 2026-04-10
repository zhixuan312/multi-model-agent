import type { Provider, RunResult, TaskSpec, MultiModelConfig } from './types.js';
import { createProvider } from './provider.js';
import { getProviderEligibility } from './routing/get-provider-eligibility.js';
import { selectProviderForTask } from './routing/select-provider-for-task.js';

function errorResult(error: string): RunResult {
  return {
    output: `Sub-agent error: ${error}`,
    status: 'error',
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: null },
    turns: 0,
    filesRead: [],
    filesWritten: [],
    toolCalls: [],
    error,
  };
}

type ResolvedTask =
  | { task: TaskSpec; provider: Provider }
  | { task: TaskSpec; error: string } // routing/eligibility failure

async function executeTask(
  task: TaskSpec,
  provider: Provider,
  config: MultiModelConfig,
): Promise<RunResult> {
  try {
    return await provider.run(task.prompt, {
      tools: task.tools,
      maxTurns: task.maxTurns,
      timeoutMs: task.timeoutMs,
      cwd: task.cwd,
      effort: task.effort,
      sandboxPolicy: task.sandboxPolicy,
    });
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Run tasks concurrently. Each RunResult corresponds to the matching TaskSpec
 * at the same index. One task failing does not affect others.
 */
export async function runTasks(
  tasks: TaskSpec[],
  config: MultiModelConfig,
): Promise<RunResult[]> {
  if (tasks.length === 0) return [];

  const resolved: ResolvedTask[] = tasks.map((task): ResolvedTask => {
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
        provider: createProvider(task.provider, config),
      };
    }

    // Auto-routing
    const selected = selectProviderForTask(task, config);
    if (!selected) {
      const available = Object.keys(config.providers);
      return {
        task,
        error: `No eligible provider found for task (required tier: ${task.tier}, capabilities: ${task.requiredCapabilities.join(', ') || 'none'}). Available providers: ${available.join(', ') || 'none'}.`,
      };
    }
    return {
      task,
      provider: createProvider(selected.name, config),
    };
  });

  return Promise.all(
    resolved.map((r): Promise<RunResult> => {
      if ('error' in r) {
        return Promise.resolve(errorResult(r.error));
      }
      return executeTask(r.task, r.provider, config);
    }),
  );
}
