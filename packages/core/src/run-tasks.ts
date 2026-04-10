import type { Provider, RunResult, TaskSpec, MultiModelConfig } from './types.js';
import { createProvider } from './provider.js';
import { getProviderEligibility } from './routing/get-provider-eligibility.js';
import { selectProviderForTask } from './routing/select-provider-for-task.js';
import { buildEscalationChain, delegateWithEscalation } from './delegate-with-escalation.js';

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
): Promise<RunResult> {
  try {
    if (resolved.pinned) {
      // Explicit pin: chain of length 1, no escalation.
      return await delegateWithEscalation(
        resolved.task,
        [resolved.provider],
        { explicitlyPinned: true },
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
    return await delegateWithEscalation(resolved.task, chain);
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
    resolved.map((r): Promise<RunResult> => {
      if ('error' in r) {
        return Promise.resolve(errorResult(r.error));
      }
      return executeTask(r, config);
    }),
  );
}
