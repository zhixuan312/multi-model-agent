import type { Provider, AgentType, RunResult } from '../types.js';
import type { RunStatus } from '../runners/types.js';

export const TRANSPORT_FAILURES: ReadonlySet<RunStatus> = new Set([
  'api_error',
  'network_error',
  'timeout',
]);

export type FallbackReason = 'transport_failure' | 'not_configured';
export type UnavailableMap = Map<AgentType, FallbackReason>;

/** First-write-wins. Preserves root cause across the loop. */
export function markUnavailable(
  map: UnavailableMap,
  tier: AgentType,
  reason: FallbackReason,
): void {
  if (!map.has(tier)) map.set(tier, reason);
}

export function otherTier(t: AgentType): AgentType {
  return t === 'standard' ? 'complex' : 'standard';
}

export interface RunWithFallbackInput<T> {
  assigned: AgentType;
  providerFor: (tier: AgentType) => Provider | undefined;
  unavailableTiers: UnavailableMap;
  isTransportFailure: (result: T) => boolean;
  /** Caller-supplied status extractor. Replaces unsafe `(result as any).status` casts.
   *  Returns undefined for results that don't carry a status field (custom T types). */
  getStatus?: (result: T) => RunStatus | undefined;
  makeSyntheticFailure: (assigned: AgentType) => T;
  call: (provider: Provider) => Promise<T>;
}

export interface RunWithFallbackResult<T> {
  result: T;
  usedTier: AgentType | 'none';

  /** True iff an alternate tier was actually USED for a provider call (not just considered).
   *  False when both tiers were unavailable up-front (no provider call made).
   *  Used by lifecycle to decide whether to emit a `fallback` event (yes iff fallbackFired).
   *  Distinct from `bothUnavailable` (which means "no usable result"). */
  fallbackFired: boolean;
  /** Why the substitution was attempted. Present iff fallbackFired or assignedUnavailableReason set. */
  fallbackReason?: FallbackReason;
  /** Status of the call that triggered the substitution (assigned-tier failure). Present iff
   *  fallbackReason === 'transport_failure' AND a real call occurred. */
  fallbackTriggeringStatus?: RunStatus;

  /** True iff the wrapper could not produce a usable result. */
  bothUnavailable: boolean;
  /** Why the FINAL tier (alt or assigned) was unavailable. Present iff bothUnavailable. */
  unavailableReason?: FallbackReason;
  /** Status of the alt-tier failure that produced bothUnavailable mid-call. Present iff
   *  bothUnavailable AND mid-call double-failure path AND alt was actually called. */
  unavailableTriggeringStatus?: RunStatus;

  /** Why the assigned tier was unavailable up-front (sticky or not-configured). Present iff
   *  fallbackReason set without calling assigned. Distinct from `fallbackReason` so callers
   *  can tell "we substituted at the start" vs "we substituted because the assigned call failed". */
  assignedUnavailableReason?: FallbackReason;
}

export async function runWithFallback<T>(
  input: RunWithFallbackInput<T>,
): Promise<RunWithFallbackResult<T>> {
  const { assigned, providerFor, unavailableTiers, isTransportFailure, makeSyntheticFailure, call } = input;
  const getStatus = input.getStatus ?? (() => undefined);

  // ── Step 1: resolve assigned tier (sticky check first, then not-configured) ──
  let usedTier: AgentType | 'none' = assigned;
  let fallbackFired = false;
  let fallbackReason: FallbackReason | undefined;
  let assignedUnavailableReason: FallbackReason | undefined;

  if (unavailableTiers.has(assigned)) {
    assignedUnavailableReason = unavailableTiers.get(assigned)!;
    fallbackReason = assignedUnavailableReason;
  } else if (providerFor(assigned) === undefined) {
    markUnavailable(unavailableTiers, assigned, 'not_configured');
    assignedUnavailableReason = 'not_configured';
    fallbackReason = 'not_configured';
  }

  if (fallbackReason !== undefined) {
    // Assigned is unavailable up-front. Try the alt tier.
    const alt = otherTier(assigned);
    let altUnavailableReason: FallbackReason | undefined;
    if (unavailableTiers.has(alt)) {
      altUnavailableReason = unavailableTiers.get(alt)!;
    } else if (providerFor(alt) === undefined) {
      markUnavailable(unavailableTiers, alt, 'not_configured');
      altUnavailableReason = 'not_configured';
    }
    if (altUnavailableReason !== undefined) {
      // Both unavailable up-front. Report the BLOCKING tier's reason (the alt's, since
      // the alt is what we actually tried to use — round-1 audit C4 fix).
      return {
        result: makeSyntheticFailure(assigned),
        usedTier: 'none',
        fallbackFired: false,
        bothUnavailable: true,
        fallbackReason,
        assignedUnavailableReason,
        unavailableReason: altUnavailableReason,
      };
    }
    usedTier = alt;
    fallbackFired = true;
  }

  // ── Step 4: call the chosen provider ──
  const provider = providerFor(usedTier as AgentType)!;
  const result = await call(provider);

  if (!isTransportFailure(result)) {
    // Success (or non-transport failure passed through) — return current state.
    return {
      result,
      usedTier,
      fallbackFired,
      fallbackReason,
      assignedUnavailableReason,
      bothUnavailable: false,
    };
  }

  // Transport failure on the called tier. Capture the original triggering status.
  const calledStatus = getStatus(result);
  markUnavailable(unavailableTiers, usedTier as AgentType, 'transport_failure');

  // If the called tier WAS the alt (i.e. we already substituted before calling),
  // there's no further alt to try; we've burned both options.
  if (fallbackFired) {
    return {
      result,
      usedTier,
      fallbackFired: true,
      fallbackReason,
      fallbackTriggeringStatus: calledStatus,
      assignedUnavailableReason,
      bothUnavailable: true,
      unavailableReason: 'transport_failure',
      unavailableTriggeringStatus: calledStatus,
    };
  }

  // The assigned tier just failed in this call. Promote to fallback path.
  fallbackReason = 'transport_failure';
  const fallbackTriggeringStatus = calledStatus;
  const altOfUsed = otherTier(usedTier as AgentType);

  // Check alt availability (sticky first, then not-configured)
  let altUnavailableReason: FallbackReason | undefined;
  if (unavailableTiers.has(altOfUsed)) {
    altUnavailableReason = unavailableTiers.get(altOfUsed)!;
  } else if (providerFor(altOfUsed) === undefined) {
    markUnavailable(unavailableTiers, altOfUsed, 'not_configured');
    altUnavailableReason = 'not_configured';
  }
  if (altUnavailableReason !== undefined) {
    // Both unavailable mid-call — assigned called and failed; alt unreachable.
    // Return the actual failed result (not synthetic) per Spec Section D step 4b.
    return {
      result,
      usedTier,
      fallbackFired: true,
      fallbackReason,
      fallbackTriggeringStatus,
      bothUnavailable: true,
      unavailableReason: altUnavailableReason,
    };
  }

  // Try alt.
  const altProvider = providerFor(altOfUsed)!;
  const altResult = await call(altProvider);
  const altStatus = getStatus(altResult);

  if (isTransportFailure(altResult)) {
    // Both transport-failed mid-call — preserve BOTH triggering statuses.
    markUnavailable(unavailableTiers, altOfUsed, 'transport_failure');
    return {
      result: altResult,
      usedTier: altOfUsed,
      fallbackFired: true,
      fallbackReason,
      fallbackTriggeringStatus,            // assigned's failure status (root cause)
      bothUnavailable: true,
      unavailableReason: 'transport_failure',
      unavailableTriggeringStatus: altStatus, // alt's failure status (final state)
    };
  }

  // Alt succeeded.
  return {
    result: altResult,
    usedTier: altOfUsed,
    fallbackFired: true,
    fallbackReason,
    fallbackTriggeringStatus,              // assigned's failure status (root cause)
    bothUnavailable: false,
  };
}

/** Lifecycle helper: builds the synthetic RunResult expected when both tiers are
 *  unavailable. Status is the new 'unavailable' value (NOT 'api_error') so
 *  re-passing the synthetic into runWithFallback's isTransportFailure cannot
 *  retrigger fallback.
 *
 *  IMPORTANT: This shape MUST satisfy `RunResult` (see types.ts). Confirmed
 *  required fields: output, status, usage, turns, filesRead, filesWritten,
 *  toolCalls, outputIsDiagnostic, escalationLog. All other RunResult fields
 *  are optional. */
export function makeSyntheticRunResult(assigned: AgentType, errorCode: string): RunResult {
  return {
    status: 'unavailable',
    output: '',
    outputIsDiagnostic: true,
    error: `runWithFallback: both tiers unavailable (assigned=${assigned})`,
    errorCode,
    retryable: false,
    turns: 0,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: 0, savedCostUSD: 0 },
    filesRead: [],
    filesWritten: [],
    toolCalls: [],
    escalationLog: [],
  };
}

export function isReviewTransportFailure(
  r: { status?: string },
): boolean {
  return r.status === 'api_error' || r.status === 'network_error' || r.status === 'timeout';
}
