import type {
  Capability,
  DelegateTask,
  ProviderConfig,
  RunOptions,
  RunResult,
} from './types.js';
import { getCapabilities } from './routing/capabilities.js';

/**
 * Computes the capabilities a task will actually have at runtime, given the
 * provider's config plus per-task option overrides. This is the enforcement
 * view — it accounts for `tools: 'none'` disabling everything and for
 * per-task `sandboxPolicy` overrides that unlock or lock shell.
 */
export function getEffectiveCapabilities(
  providerConfig: ProviderConfig,
  options: Pick<RunOptions, 'tools' | 'sandboxPolicy'>,
): Capability[] {
  // If tools are disabled for this task, no capabilities are offered.
  if (options.tools === 'none') return [];

  // Merge the per-task sandboxPolicy override (if any) into a config snapshot
  // before asking getCapabilities. The provider's persisted config is NOT
  // mutated — this is a local copy used only for the capability computation.
  const mergedConfig: ProviderConfig = {
    ...providerConfig,
    sandboxPolicy: options.sandboxPolicy ?? providerConfig.sandboxPolicy,
  };

  return getCapabilities(mergedConfig);
}

function errorResult(output: string): RunResult {
  return {
    output,
    status: 'error',
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: null },
    turns: 0,
    files: [],
    error: output,
  };
}

export async function delegateAll(tasks: DelegateTask[]): Promise<RunResult[]> {
  if (tasks.length === 0) return [];

  const promises = tasks.map(async (task): Promise<RunResult> => {
    // Enforce requiredCapabilities before dispatching. This catches capability
    // mismatches at the delegator layer rather than silently degrading inside
    // the sub-agent — e.g., a task that requires web_search routed to a
    // provider without it fails fast with a clear error, no tokens spent.
    const effectiveCaps = getEffectiveCapabilities(task.provider.config, {
      tools: task.tools,
      sandboxPolicy: task.sandboxPolicy,
    });
    const missing = task.requiredCapabilities.filter((c) => !effectiveCaps.includes(c));
    if (missing.length > 0) {
      return errorResult(
        `Provider "${task.provider.name}" cannot satisfy requiredCapabilities: ` +
          `${missing.join(', ')}. Effective capabilities for this task: ` +
          `${effectiveCaps.length > 0 ? effectiveCaps.join(', ') : '(none — tools disabled)'}.`,
      );
    }

    try {
      return await task.provider.run(task.prompt, {
        tools: task.tools,
        maxTurns: task.maxTurns,
        timeoutMs: task.timeoutMs,
        cwd: task.cwd,
        effort: task.effort,
        sandboxPolicy: task.sandboxPolicy,
      });
    } catch (err) {
      return {
        output: `Sub-agent error: ${err instanceof Error ? err.message : String(err)}`,
        status: 'error',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: null },
        turns: 0,
        files: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  return Promise.all(promises);
}
