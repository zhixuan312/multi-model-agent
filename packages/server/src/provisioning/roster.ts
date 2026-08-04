// Declared-over-detected client roster resolution. An explicit `on`/`off`
// declaration is always authoritative; detection alone can never cause a
// mutation -- an undeclared-but-detected client is reported 'suggested' and
// left untouched (FR-7a).
import { CLIENT_IDS, type ClientId, type ClientState } from '@zhixuan92/multi-model-agent-core';

export interface EffectiveClientRosterEntry {
  clientId: ClientId;
  declaredState: ClientState | null;
  detectedPresence: boolean;
  effectiveState: ClientState | 'suggested';
}

/** Partial declared roster, keyed by ClientId -- mirrors the strict config's
 *  optional `clients` block. */
export type DeclaredClientRoster = Partial<Record<ClientId, ClientState>>;

/**
 * Resolves the effective roster for all eight canonical clients, in
 * CLIENT_IDS order.
 *
 * Algorithm: if `declared[clientId]` is `'on'` or `'off'`, that value wins.
 * Otherwise the effective state is `'suggested'` when the client is
 * detected, else `'off'`. A `'suggested'` result is reported only -- it must
 * never be provisioned or removed.
 */
export function resolveEffectiveRoster(
  declared: DeclaredClientRoster | undefined,
  detected: ReadonlySet<ClientId>,
): EffectiveClientRosterEntry[] {
  return CLIENT_IDS.map((clientId) => {
    const declaredState = declared?.[clientId] ?? null;
    const detectedPresence = detected.has(clientId);
    const effectiveState: ClientState | 'suggested' =
      declaredState ?? (detectedPresence ? 'suggested' : 'off');
    return { clientId, declaredState, detectedPresence, effectiveState };
  });
}
