import type {
  TaskSpec,
  RunResult,
  Provider,
  AttemptRecord,
  MultiModelConfig,
  CostTier,
} from './types.js';
import { createProvider } from './provider.js';
import { getProviderEligibility } from './routing/get-provider-eligibility.js';
import { getEffectiveCostTier } from './routing/model-profiles.js';

export interface DelegateOptions {
  /** When true, the orchestrator does not walk the chain on failure —
   *  the first (and only) provider's result is returned as-is. */
  explicitlyPinned?: boolean;
}

// NOTE: must stay byte-identical to the ordering in
// routing/select-provider-for-task.ts so the head of the escalation chain is
// the same provider auto-routing would have picked. If you change one, change
// both.
const COST_ORDER: Record<CostTier, number> = { free: 0, low: 1, medium: 2, high: 3 };

/**
 * Build the escalation chain for an auto-routed task. Returns all eligible
 * providers sorted cheapest-first with alphabetical tiebreak — this mirrors
 * `selectProviderForTask`'s ordering so the first element of the chain is the
 * same provider auto-routing would have picked.
 *
 * Eligibility (capability + tier filters) is handled entirely by
 * `getProviderEligibility`; we just drop the ineligible entries.
 */
export function buildEscalationChain(
  task: TaskSpec,
  config: MultiModelConfig,
): Provider[] {
  const eligibility = getProviderEligibility(task, config);
  const eligible = eligibility.filter((e) => e.eligible);

  eligible.sort((a, b) => {
    const aTier = COST_ORDER[getEffectiveCostTier(a.config)] ?? 3;
    const bTier = COST_ORDER[getEffectiveCostTier(b.config)] ?? 3;
    if (aTier !== bTier) return aTier - bTier;
    return a.name.localeCompare(b.name);
  });

  return eligible.map((e) => createProvider(e.name, config));
}

/**
 * Walks the provider chain for an auto-routed task. Returns the first
 * successful result; if all attempts fail, returns the best salvageable
 * output (longest non-empty) with status 'incomplete' and the full
 * escalation log.
 *
 * For explicitly-pinned tasks, the chain has length 1 and there is no
 * walking — the pinned provider's result is returned as-is. See spec
 * Part A.4.
 */
export async function delegateWithEscalation(
  task: TaskSpec,
  chain: Provider[],
  options: DelegateOptions = {},
): Promise<RunResult> {
  if (chain.length === 0) {
    throw new Error('delegateWithEscalation called with empty chain');
  }

  const attempts: { result: RunResult; record: AttemptRecord }[] = [];

  for (const provider of chain) {
    const result = await provider.run(task.prompt, {
      tools: task.tools,
      maxTurns: task.maxTurns,
      timeoutMs: task.timeoutMs,
      cwd: task.cwd,
      effort: task.effort,
      sandboxPolicy: task.sandboxPolicy,
    });

    const record: AttemptRecord = {
      provider: provider.name,
      status: result.status,
      turns: result.turns,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      costUSD: result.usage.costUSD,
      // TODO(Task 12): populate these via RunOptions.onInitialRequest so the
      // orchestrator can record the length/hash of the first request body
      // actually sent on each attempt. For Task 6, stub with zero/empty.
      initialPromptLengthChars: 0,
      initialPromptHash: '',
      // Use `||` (not `??`) so an empty-string error falls through to the
      // status sentinel — an empty `reason` would be indistinguishable from
      // an `ok` row in the escalation log.
      reason:
        result.status === 'ok'
          ? undefined
          : (result.error || `status=${result.status}`),
    };

    attempts.push({ result, record });

    if (result.status === 'ok') {
      return {
        ...result,
        escalationLog: attempts.map((a) => a.record),
      };
    }

    // Pinned: stop after the first attempt regardless of status.
    if (options.explicitlyPinned) {
      return {
        ...result,
        escalationLog: attempts.map((a) => a.record),
      };
    }
  }

  // All providers failed. Return the best salvageable output (longest).
  // Note: the `ok` short-circuit above means every entry here is non-ok,
  // so the status-remap below is defensive only.
  let best = attempts[0].result;
  for (const a of attempts) {
    if (a.result.output.length > best.output.length) {
      best = a.result;
    }
  }

  return {
    ...best,
    status: best.status === 'ok' ? 'incomplete' : best.status,
    escalationLog: attempts.map((a) => a.record),
  };
}
