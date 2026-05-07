import type { Provider, AgentType } from '../types.js';
import { canonicalIdentity, identityEquals, type CanonicalIdentity } from '../config/canonical-model-identity.js';
import { otherTier } from '../config/tier-policy-registry.js';
import { providersIdentical, scoreWork } from './fallback-helpers.js';
import { TRANSPORT_FAILURES, type FallbackReason, type UnavailableMap, markUnavailable, type RunWithFallbackInput, type RunWithFallbackResult } from './fallback-types.js';

export { providersIdentical, makeSyntheticRunResult, isReviewTransportFailure } from './fallback-helpers.js';
export { TRANSPORT_FAILURES, type FallbackReason, type UnavailableMap, type RunWithFallbackInput, type RunWithFallbackResult } from './fallback-types.js';

export async function runWithFallback<T>(
  input: RunWithFallbackInput<T>,
): Promise<RunWithFallbackResult<T>> {
  const { assigned, providerFor, unavailableTiers, isTransportFailure, makeSyntheticFailure, call } = input;
  const getStatus = input.getStatus ?? (() => undefined);
  const forbidden = input.forbiddenIdentities ?? [];

  // Returns { skip: true } when the tier should be skipped due to identity separation.
  // providerFor throws/returns undefined → { skip: false }; canonicalIdentity throws → { skip: true } (fail-closed).
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
      return { skip: true };
    }
  };

  const resolveProviderIdentity = (tier: AgentType): CanonicalIdentity | null => {
    let p: Provider | undefined;
    try { p = providerFor(tier); } catch { return null; }
    if (!p) return null;
    try { return canonicalIdentity(p.config); } catch { return null; }
  };

  const assignedIdentity = resolveProviderIdentity(assigned) ?? undefined;

  // Resolve assigned tier (sticky check first, then not-configured)
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
      // Both unavailable up-front. If separation was the blocking reason,
      // surface it as the unavailableReason so callers like
      // adaptForAllTiersUnavailable can map to the correct errorCode.
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
          salvageResult: null,
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
        salvageResult: null,
      };
    }
    usedTier = alt;
    fallbackFired = true;
  }

  // Call the chosen provider
  let provider: Provider;
  try {
    provider = providerFor(usedTier as AgentType)!;
  } catch {
    // providerFor threw — construction failure on the chosen tier.
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
          salvageResult: null,
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
        salvageResult: null,
        ...(forbidden.length > 0 ? {
          fallbackSeparationRespected: skippedDueToSeparation || undefined,
          assignedIdentity,
          usedIdentity: undefined,
        } : {}),
      };
    }
  }
  const result = await call(provider, usedTier as AgentType);

  if (!isTransportFailure(result)) {
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
      salvageResult: null,
      ...(forbidden.length > 0 ? {
        fallbackSeparationRespected: skippedDueToSeparation || undefined,
        assignedIdentity,
        usedIdentity,
      } : {}),
    };
  }

  // Transport failure on the called tier
  const calledStatus = getStatus(result);
  markUnavailable(unavailableTiers, usedTier as AgentType, 'transport_failure');
  if (!usedIdentity) {
    try { usedIdentity = canonicalIdentity(provider.config) ?? undefined; } catch { /* leave undefined */ }
  }

  // If the called tier WAS the alt (already substituted), no further alt to try
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
      salvageResult: null,
      ...(forbidden.length > 0 ? {
        fallbackSeparationRespected: skippedDueToSeparation || undefined,
        assignedIdentity,
        usedIdentity,
      } : {}),
    };
  }

  // Assigned tier just failed. Promote to fallback path.
  fallbackReason = 'transport_failure';
  const fallbackTriggeringStatus = calledStatus;
  const altOfUsed = otherTier(usedTier as AgentType);

  // Same-provider short-circuit: if alt points at the same backend as assigned,
  // fallback is structurally pointless — skip the doomed call.
  const altProviderForSameCheck = providerFor(altOfUsed);
  if (altProviderForSameCheck !== undefined && providersIdentical(provider, altProviderForSameCheck)) {
    const sameProviderSep = forbidden.length > 0 ? checkSeparation(usedTier as AgentType) : { skip: false };
    return {
      result,
      usedTier,
      fallbackFired: false,
      bothUnavailable: false,
      salvageResult: null,
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
    return {
      result,
      usedTier,
      fallbackFired: true,
      fallbackReason,
      fallbackTriggeringStatus,
      bothUnavailable: true,
      unavailableReason: altUnavailableReason,
      salvageResult: null,
      ...(forbidden.length > 0 ? {
        fallbackSeparationRespected: altSeparation || skippedDueToSeparation || undefined,
        assignedIdentity,
        usedIdentity,
      } : {}),
    };
  }

  // Try alt
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
      salvageResult: null,
      ...(forbidden.length > 0 ? {
        fallbackSeparationRespected: skippedDueToSeparation || undefined,
        assignedIdentity,
        usedIdentity,
      } : {}),
    };
  }
  const altResult = await call(altProvider, altOfUsed);
  if (!usedIdentity) {
    try { usedIdentity = canonicalIdentity(altProvider.config) ?? undefined; } catch { /* leave undefined */ }
  }
  const altStatus = getStatus(altResult);

  if (isTransportFailure(altResult)) {
    // Both transport-failed mid-call — preserve BOTH triggering statuses
    markUnavailable(unavailableTiers, altOfUsed, 'transport_failure');
    const firstWork = scoreWork(result);
    const altWork = scoreWork(altResult);
    const maxWork = Math.max(firstWork, altWork);
    const salvageResult = maxWork > 0
      ? (firstWork >= altWork ? result : altResult)
      : null;
    return {
      result: altResult,
      usedTier: altOfUsed,
      fallbackFired: true,
      fallbackReason,
      fallbackTriggeringStatus,
      bothUnavailable: true,
      unavailableReason: 'transport_failure',
      unavailableTriggeringStatus: altStatus,
      salvageResult,
      ...(forbidden.length > 0 ? {
        fallbackSeparationRespected: skippedDueToSeparation || undefined,
        assignedIdentity,
        usedIdentity,
      } : {}),
    };
  }

  // Alt succeeded
  return {
    result: altResult,
    usedTier: altOfUsed,
    fallbackFired: true,
    fallbackReason,
    fallbackTriggeringStatus,
    bothUnavailable: false,
    salvageResult: null,
    ...(forbidden.length > 0 ? {
      fallbackSeparationRespected: skippedDueToSeparation || undefined,
      assignedIdentity,
      usedIdentity,
    } : {}),
  };
}
