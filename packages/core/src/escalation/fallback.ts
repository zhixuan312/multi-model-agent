import type { Provider, AgentType, RunResult } from '../types.js';
import type { RunStatus } from '../runners/types.js';
import { canonicalIdentity, identityEquals, type CanonicalIdentity } from '../routing/canonical-model-identity.js';

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

/** Two providers are "identical" iff they resolve to the same effective backend
 *  (type + model + baseUrl + apiKey wiring). When an operator points both tiers
 *  at the same backend (one-provider deployment), cross-tier fallback is
 *  structurally pointless — alt would just hit the same place. Comparing the
 *  serialized config catches this without a new operator-facing flag. */
export function providersIdentical(a: Provider, b: Provider): boolean {
  return JSON.stringify(a.config) === JSON.stringify(b.config);
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
  /** Canonical identities to exclude from candidate selection. When a candidate
   *  provider's resolved identity matches one in this set, the candidate is skipped
   *  as a separation violation. If identity resolution throws on a successfully-constructed
   *  provider, the candidate is also skipped (fail-closed). Provider construction
   *  failures (providerFor throws/returns undefined) follow the existing unavailable path. */
  forbiddenIdentities?: CanonicalIdentity[];
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

  /** True iff the final used tier differs in canonical identity from all forbiddenIdentities.
   *  Set only when forbiddenIdentities was provided. */
  fallbackSeparationRespected?: boolean;
  /** Canonical identity of the assigned tier's provider (resolved at selection time). */
  assignedIdentity?: CanonicalIdentity;
  /** Canonical identity of the actually-used tier's provider. */
  usedIdentity?: CanonicalIdentity;
}

export async function runWithFallback<T>(
  input: RunWithFallbackInput<T>,
): Promise<RunWithFallbackResult<T>> {
  const { assigned, providerFor, unavailableTiers, isTransportFailure, makeSyntheticFailure, call } = input;
  const getStatus = input.getStatus ?? (() => undefined);
  const forbidden = input.forbiddenIdentities ?? [];

  // ── Helpers for identity separation ──
  // Returns { skip: true } when the tier should be skipped due to separation.
  // - providerFor throws → { skip: false } (construction failure, NOT separation)
  // - providerFor returns undefined → { skip: false } (unavailable, NOT separation)
  // - canonicalIdentity throws → { skip: true } (fail-closed: provider exists but identity unresolvable)
  // - identity matches forbiddenIdentities → { skip: true }
  // - identity differs → { skip: false, identity }
  const checkSeparation = (tier: AgentType): { skip: boolean; identity?: CanonicalIdentity } => {
    if (forbidden.length === 0) return { skip: false };
    let p: Provider | undefined;
    try { p = providerFor(tier); } catch { return { skip: false }; }
    if (!p) return { skip: false };
    try {
      const id = canonicalIdentity(p.config);
      if (forbidden.some(f => identityEquals(f, id))) return { skip: true, identity: id };
      return { skip: false, identity: id };
    } catch {
      // Identity unresolvable on a successfully-constructed provider: fail closed.
      return { skip: true };
    }
  };

  const resolveProviderIdentity = (tier: AgentType): CanonicalIdentity | null => {
    let p: Provider | undefined;
    try { p = providerFor(tier); } catch { return null; }
    if (!p) return null;
    try { return canonicalIdentity(p.config); } catch { return null; }
  };

  // ── Resolve assigned identity (before any availability checks) ──
  const assignedIdentity = resolveProviderIdentity(assigned) ?? undefined;

  // ── Step 1: resolve assigned tier (sticky check first, then not-configured) ──
  let usedTier: AgentType | 'none' = assigned;
  let fallbackFired = false;
  let fallbackReason: FallbackReason | undefined;
  let assignedUnavailableReason: FallbackReason | undefined;
  let skippedDueToSeparation = false;
  let usedIdentity: CanonicalIdentity | undefined = assignedIdentity;

  if (unavailableTiers.has(assigned)) {
    assignedUnavailableReason = unavailableTiers.get(assigned)!;
    fallbackReason = assignedUnavailableReason;
  } else {
    let assignedProvider: Provider | undefined;
    try { assignedProvider = providerFor(assigned); } catch { /* construction failure → treat as unavailable below */ }
    if (assignedProvider === undefined) {
      markUnavailable(unavailableTiers, assigned, 'not_configured');
      assignedUnavailableReason = 'not_configured';
      fallbackReason = 'not_configured';
    } else {
      const sep = checkSeparation(assigned);
      if (sep.skip) {
        skippedDueToSeparation = true;
        fallbackReason = 'not_configured';
      } else if (sep.identity) {
        usedIdentity = sep.identity;
      }
    }
  }

  if (fallbackReason !== undefined) {
    // Assigned is unavailable up-front (or forbidden). Try the alt tier.
    const alt = otherTier(assigned);
    let altUnavailableReason: FallbackReason | undefined;
    if (unavailableTiers.has(alt)) {
      altUnavailableReason = unavailableTiers.get(alt)!;
    } else {
      let altProv: Provider | undefined;
      try { altProv = providerFor(alt); } catch { /* construction failure */ }
      if (altProv === undefined) {
        markUnavailable(unavailableTiers, alt, 'not_configured');
        altUnavailableReason = 'not_configured';
      } else {
        const altSep = checkSeparation(alt);
        if (altSep.skip) {
          skippedDueToSeparation = true;
          altUnavailableReason = 'not_configured';
        } else if (altSep.identity) {
          usedIdentity = altSep.identity;
        }
      }
    }
    if (altUnavailableReason !== undefined) {
      // Both unavailable up-front. If separation was the blocking reason for
      // either tier, emit the separation error code.
      if (skippedDueToSeparation) {
        return {
          result: makeSyntheticFailure(assigned),
          usedTier: 'none',
          fallbackFired: false,
          bothUnavailable: true,
          fallbackReason,
          assignedUnavailableReason,
          unavailableReason: altUnavailableReason,
          fallbackSeparationRespected: true,
          assignedIdentity,
          usedIdentity: undefined,
        };
      }
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
  let provider: Provider;
  try {
    provider = providerFor(usedTier as AgentType)!;
  } catch {
    // providerFor threw — construction failure on the chosen tier.
    // If fallback hasn't fired yet, try alt; otherwise both exhausted.
    if (!fallbackFired) {
      const alt = otherTier(usedTier as AgentType);
      fallbackFired = true;
      usedTier = alt;
      try {
        provider = providerFor(alt)!;
      } catch {
        return {
          result: makeSyntheticFailure(assigned),
          usedTier: 'none',
          fallbackFired: true,
          bothUnavailable: true,
          fallbackReason: 'not_configured',
          assignedUnavailableReason,
          unavailableReason: 'not_configured',
          ...(forbidden.length > 0 ? {
            fallbackSeparationRespected: skippedDueToSeparation || undefined,
            assignedIdentity,
            usedIdentity: undefined,
          } : {}),
        };
      }
    } else {
      return {
        result: makeSyntheticFailure(assigned),
        usedTier: 'none',
        fallbackFired: true,
        bothUnavailable: true,
        fallbackReason,
        assignedUnavailableReason,
        unavailableReason: 'not_configured',
        ...(forbidden.length > 0 ? {
          fallbackSeparationRespected: skippedDueToSeparation || undefined,
          assignedIdentity,
          usedIdentity: undefined,
        } : {}),
      };
    }
  }
  const result = await call(provider);

  if (!isTransportFailure(result)) {
    // Resolve usedIdentity from the actually-used provider if not already set
    if (!usedIdentity) {
      try { usedIdentity = canonicalIdentity(provider.config) ?? undefined; } catch { /* leave undefined */ }
    }
    return {
      result,
      usedTier,
      fallbackFired,
      fallbackReason,
      assignedUnavailableReason,
      bothUnavailable: false,
      ...(forbidden.length > 0 ? {
        fallbackSeparationRespected: skippedDueToSeparation || undefined,
        assignedIdentity,
        usedIdentity,
      } : {}),
    };
  }

  // Transport failure on the called tier. Capture the original triggering status.
  const calledStatus = getStatus(result);
  markUnavailable(unavailableTiers, usedTier as AgentType, 'transport_failure');
  if (!usedIdentity) {
    try { usedIdentity = canonicalIdentity(provider.config) ?? undefined; } catch { /* leave undefined */ }
  }

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
      ...(forbidden.length > 0 ? {
        fallbackSeparationRespected: skippedDueToSeparation || undefined,
        assignedIdentity,
        usedIdentity,
      } : {}),
    };
  }

  // The assigned tier just failed in this call. Promote to fallback path.
  fallbackReason = 'transport_failure';
  const fallbackTriggeringStatus = calledStatus;
  const altOfUsed = otherTier(usedTier as AgentType);

  // Same-provider short-circuit: if alt resolves to a provider with the same
  // effective config as the assigned tier (operator pointing both tiers at one
  // backend), fallback would just hit the same backend. Skip the doomed call
  // and return the assigned-tier failure as the terminal result. We do NOT
  // mark alt unavailable here — the failure may be transient, and a future
  // rework attempt should still be allowed to try.
  const altProviderForSameCheck = providerFor(altOfUsed);
  if (altProviderForSameCheck !== undefined && providersIdentical(provider, altProviderForSameCheck)) {
    // Also check if the same-provider situation constitutes a separation violation
    const sameProviderSep = forbidden.length > 0 ? checkSeparation(usedTier as AgentType) : { skip: false };
    return {
      result,
      usedTier,
      fallbackFired: false,
      bothUnavailable: false,
      ...(forbidden.length > 0 ? {
        fallbackSeparationRespected: sameProviderSep.skip || skippedDueToSeparation || undefined,
        assignedIdentity,
        usedIdentity,
      } : {}),
    };
  }

  // Check alt availability (sticky first, then not-configured, then separation)
  let altUnavailableReason: FallbackReason | undefined;
  let altSeparation = false;
  if (unavailableTiers.has(altOfUsed)) {
    altUnavailableReason = unavailableTiers.get(altOfUsed)!;
  } else {
    let altProv2: Provider | undefined;
    try { altProv2 = providerFor(altOfUsed); } catch { /* construction failure */ }
    if (altProv2 === undefined) {
      markUnavailable(unavailableTiers, altOfUsed, 'not_configured');
      altUnavailableReason = 'not_configured';
    } else {
      const altSep = checkSeparation(altOfUsed);
      if (altSep.skip) {
        altSeparation = true;
        altUnavailableReason = 'not_configured';
      } else if (altSep.identity) {
        usedIdentity = altSep.identity;
      }
    }
  }
  if (altUnavailableReason !== undefined) {
    // Both unavailable mid-call — assigned called and failed; alt unreachable.
    return {
      result,
      usedTier,
      fallbackFired: true,
      fallbackReason,
      fallbackTriggeringStatus,
      bothUnavailable: true,
      unavailableReason: altUnavailableReason,
      ...(forbidden.length > 0 ? {
        fallbackSeparationRespected: altSeparation || skippedDueToSeparation || undefined,
        assignedIdentity,
        usedIdentity,
      } : {}),
    };
  }

  // Try alt.
  let altProvider: Provider;
  try {
    altProvider = providerFor(altOfUsed)!;
  } catch {
    return {
      result,
      usedTier,
      fallbackFired: true,
      fallbackReason,
      fallbackTriggeringStatus,
      bothUnavailable: true,
      unavailableReason: 'not_configured',
      ...(forbidden.length > 0 ? {
        fallbackSeparationRespected: skippedDueToSeparation || undefined,
        assignedIdentity,
        usedIdentity,
      } : {}),
    };
  }
  const altResult = await call(altProvider);
  // Resolve usedIdentity from the alt provider if not already set
  if (!usedIdentity) {
    try { usedIdentity = canonicalIdentity(altProvider.config) ?? undefined; } catch { /* leave undefined */ }
  }
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
      ...(forbidden.length > 0 ? {
        fallbackSeparationRespected: skippedDueToSeparation || undefined,
        assignedIdentity,
        usedIdentity,
      } : {}),
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
    ...(forbidden.length > 0 ? {
      fallbackSeparationRespected: skippedDueToSeparation || undefined,
      assignedIdentity,
      usedIdentity,
    } : {}),
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
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: 0, costDeltaVsParentUSD: 0, cachedTokens: null, reasoningTokens: null },
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
