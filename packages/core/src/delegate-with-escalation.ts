import type {
  TaskSpec,
  RunResult,
  Provider,
  AttemptRecord,
  MultiModelConfig,
  CostTier,
  ProgressEvent,
} from './types.js';
import { createProvider } from './provider.js';
import { getProviderEligibility } from './routing/get-provider-eligibility.js';
import { getEffectiveCostTier } from './routing/model-profiles.js';

export interface DelegateOptions {
  /** When true, the orchestrator does not walk the chain on failure —
   *  the first (and only) provider's result is returned as-is. */
  explicitlyPinned?: boolean;
  /** Optional in-flight progress sink. When provided, it is threaded into
   *  every `provider.run(...)` call so runners can emit turn/tool/injection
   *  events, and the orchestrator itself emits one `escalation_start` event
   *  between attempts whenever it hops to the next provider in the chain.
   *  The callback MUST NOT throw. See `ProgressEvent` for variants. */
  onProgress?: (event: ProgressEvent) => void;
}

// NOTE: must stay byte-identical to the ordering in
// routing/select-provider-for-task.ts so the head of the escalation chain is
// the same provider auto-routing would have picked. If you change one, change
// both.
const COST_ORDER: Record<CostTier, number> = { free: 0, low: 1, medium: 2, high: 3 };

/**
 * Status values where `output` is produced by the normal salvage path
 * (scratchpad text captured by the runner before termination). These rank
 * above error-flavored statuses in the all-fail fallback: a genuinely short
 * piece of partial work beats a long `Sub-agent error: …` diagnostic.
 *
 * `error` / `api_aborted` / `api_error` / `network_error` deliberately do
 * NOT appear here. Runners still salvage scratchpad on those paths when
 * the scratchpad is non-empty, but we cannot tell at the orchestrator
 * layer whether their `output` is real salvaged content or the fallback
 * error-diagnostic string — so we prefer any salvage-flavored attempt
 * first, and only fall back to error-flavored attempts if none exist.
 */
const SALVAGE_FLAVORED_STATUSES: ReadonlySet<RunResult['status']> = new Set([
  'incomplete',
  'max_turns',
  'timeout',
]);

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

  // Wrap the user-supplied sink with try/catch so a throwing callback can
  // never corrupt a task. The contract says callbacks MUST NOT throw, but
  // Tasks 9-11 will call this from hot runner loops — defense in depth.
  // This wrapper is also the callback handed to `provider.run`, so runner
  // emissions are covered by the same guard.
  const safeSink: ((event: ProgressEvent) => void) | undefined = options.onProgress
    ? (event) => {
        try {
          options.onProgress!(event);
        } catch {
          // Swallow — a broken sink must not affect dispatch.
        }
      }
    : undefined;

  const attempts: { result: RunResult; record: AttemptRecord }[] = [];

  for (let i = 0; i < chain.length; i++) {
    const provider = chain[i];

    // Emit one `escalation_start` between attempts (never before the first).
    // The previous attempt's record is guaranteed to exist here because i>0.
    if (i > 0 && safeSink) {
      const prev = attempts[attempts.length - 1].record;
      safeSink({
        kind: 'escalation_start',
        previousProvider: prev.provider,
        previousReason: prev.reason ?? `status=${prev.status}`,
        nextProvider: provider.name,
      });
    }

    // Per-attempt metadata captured via the runner's `onInitialRequest`
    // callback. Reset inside the loop so a subsequent escalation hop
    // starts fresh. The runner invokes this exactly once per attempt
    // (Task 12). We wrap assignment in try/catch at the runner site, but
    // assigning to these locals cannot itself throw.
    let initialPromptLengthChars = 0;
    let initialPromptHash = '';

    const result = await provider.run(task.prompt, {
      tools: task.tools,
      maxTurns: task.maxTurns,
      timeoutMs: task.timeoutMs,
      cwd: task.cwd,
      effort: task.effort,
      sandboxPolicy: task.sandboxPolicy,
      onProgress: safeSink,
      onInitialRequest: (meta) => {
        initialPromptLengthChars = meta.lengthChars;
        initialPromptHash = meta.sha256;
      },
    });

    const record: AttemptRecord = {
      provider: provider.name,
      status: result.status,
      turns: result.turns,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      costUSD: result.usage.costUSD,
      initialPromptLengthChars,
      initialPromptHash,
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

  // All providers failed. Return the best salvageable output.
  //
  // Tiered selection: prefer any attempt whose status is salvage-flavored
  // (`incomplete` / `max_turns` / `timeout`) over any error-flavored
  // attempt (`error` / `api_aborted` / `api_error` / `network_error`),
  // regardless of output length. Rationale: runners salvage scratchpad
  // content into `output` on every termination path, but on error paths
  // `output` may just be a `Sub-agent error: …` diagnostic string (when
  // the scratchpad was empty). Without this tiering, a late error with
  // a long error message beats an earlier incomplete with a genuine
  // shorter partial answer — discarding useful work.
  //
  // Within the preferred tier we still pick the longest output, because
  // a longer genuine salvage is usually more useful than a shorter one.
  //
  // Note: the `ok` short-circuit above means every entry here is non-ok,
  // so the status-remap below is defensive only.
  const salvageAttempts = attempts.filter((a) =>
    SALVAGE_FLAVORED_STATUSES.has(a.result.status),
  );
  const pool = salvageAttempts.length > 0 ? salvageAttempts : attempts;

  let best = pool[0].result;
  for (const a of pool) {
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
