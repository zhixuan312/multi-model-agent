import type { Provider, RunResult, RunOptions, TaskSpec, MultiModelConfig } from './types.js';
import { createProvider } from './provider.js';
import { getProviderEligibility } from './routing/get-provider-eligibility.js';
import { selectProviderForTask } from './routing/select-provider-for-task.js';
import { resolveTaskCapabilities } from './routing/resolve-task-capabilities.js';

function errorResult(error: string): RunResult {
  return {
    output: `Sub-agent error: ${error}`,
    status: 'error',
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: null },
    turns: 0,
    files: [],
    error,
  };
}

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

  const resolved = tasks.map((task): { task: TaskSpec; provider: Provider } => {
    // If provider specified, validate and use it
    if (task.provider) {
      const eligibility = getProviderEligibility(task, config);
      const report = eligibility.find((e) => e.name === task.provider);
      if (!report) {
        // Provider not found in config
        const notFoundProvider = createProvider(task.provider, {
          providers: {},
          defaults: config.defaults,
        });
        return { task, provider: notFoundProvider };
      }
      if (!report.eligible) {
        const reasons = report.reasons.map((r) => r.message).join('; ');
        return {
          task,
          provider: createProvider(report.name, config),
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
      return {
        task,
        provider: createProvider(Object.keys(config.providers)[0], config),
      };
    }
    return {
      task,
      provider: createProvider(selected.name, config),
    };
  });

  return Promise.all(
    resolved.map(({ task, provider }) => executeTask(task, provider, config)),
  );
}