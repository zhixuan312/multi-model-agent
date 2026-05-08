import type { RunStatus } from '../providers/runner-types.js';
import type { AgentType, Provider } from '../types.js';
import type { CanonicalIdentity } from '../config/canonical-model-identity.js';

export const TRANSPORT_FAILURES: ReadonlySet<RunStatus> = new Set([
  'api_error',
  'provider_transport_failure',
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

export interface RunWithFallbackInput<T> {
  assigned: AgentType;
  providerFor: (tier: AgentType) => Provider | undefined;
  unavailableTiers: UnavailableMap;
  isTransportFailure: (result: T) => boolean;
  /** Caller-supplied status extractor. Replaces unsafe `(result as any).status` casts.
   *  Returns undefined for results that don't carry a status field (custom T types). */
  getStatus?: (result: T) => RunStatus | undefined;
  makeSyntheticFailure: (assigned: AgentType) => T;
  call: (provider: Provider, tier: AgentType) => Promise<T>;
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

  /** Higher-work-score of firstResult/altResult on bothUnavailable; null when both have zero work. */
  salvageResult: T | null;
}
