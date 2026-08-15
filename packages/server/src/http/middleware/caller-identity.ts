import type { IncomingMessage } from 'node:http';
import { CLIENT_IDS, AGENT_PLUGIN_CLIENT, type CallerClient } from '@zhixuan92/multi-model-agent-core';

// Derived, not hand-maintained: the canonical client roster plus the two real
// callers that are not provisioned clients — `forge` (MMA's own SDLC harness)
// and `agent-plugin` (an Agent Plugins artifact, which many clients load and
// none of them owns). `other` is deliberately absent — it is the fallback below
// for anything unrecognised, so listing it here would be unreachable: a caller
// sending `other` resolves to `other` with or without it.
const CLIENT_ALLOWLIST: ReadonlySet<string> = new Set<string>([...CLIENT_IDS, 'forge', AGENT_PLUGIN_CLIENT]);


// No model field: the cost baseline is the configured `agents.main` tier.
interface CallerIdentity {
  callerClient: CallerClient;
}

/** Default identity when no caller header is present. */
export const DEFAULT_IDENTITY: CallerIdentity = {
  callerClient: 'other',
};

export function resolveCallerIdentity(req: IncomingMessage): CallerIdentity {
  const rawClient = (req.headers['x-mma-client'] as string | undefined)?.toLowerCase().trim();

  // The fallback returns DEFAULT_IDENTITY rather than an inline `{ callerClient: 'other' }`.
  // The literal was a second copy of the same default, and it was the copy production used —
  // so `caller-identity.test.ts` asserting on DEFAULT_IDENTITY was checking a constant no
  // request ever reached. Changing the constant would have left the served default untouched.
  if (!rawClient || !CLIENT_ALLOWLIST.has(rawClient)) return DEFAULT_IDENTITY;

  return { callerClient: rawClient as CallerClient };
}
