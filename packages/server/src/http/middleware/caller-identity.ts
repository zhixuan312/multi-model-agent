import type { IncomingMessage } from 'node:http';
import { CLIENT_IDS, type CallerClient } from '@zhixuan92/multi-model-agent-core';

// Derived, not hand-maintained: the canonical client roster plus `forge`, which
// is a real caller (MMA's own SDLC harness, the sole HTTP consumer) but not a
// provisioned client. `other` is deliberately absent — it is the fallback below
// for anything unrecognised, so listing it here would be unreachable: a caller
// sending `other` resolves to `other` with or without it.
const CLIENT_ALLOWLIST: ReadonlySet<string> = new Set<string>([...CLIENT_IDS, 'forge']);


interface CallerIdentity {
  callerClient: CallerClient;
  /** Calling agent's model id (e.g., claude-opus-4-7). Sourced from the
   *  required X-MMA-Main-Model header on tool routes. Used as `mainModel`
   *  in wire telemetry so cost-delta-vs-main and family attribution can
   *  be computed. null only when the caller didn't send the header; the
   *  request pipeline rejects with 400 main_model_required on tool routes
   *  before any handler sees a null. */
  mainModel: string | null;
}

/** Default identity when no caller header is present. */
export const DEFAULT_IDENTITY: CallerIdentity = {
  callerClient: 'other',
  mainModel: null,
};

export function resolveCallerIdentity(req: IncomingMessage): CallerIdentity {
  const rawClient = (req.headers['x-mma-client'] as string | undefined)?.toLowerCase().trim();

  const callerClient = (rawClient && CLIENT_ALLOWLIST.has(rawClient))
    ? (rawClient as CallerClient)
    : 'other';

  const rawMainModel = (req.headers['x-mma-main-model'] as string | undefined)?.trim();
  const mainModel = rawMainModel && rawMainModel.length > 0 ? rawMainModel : null;

  return { callerClient, mainModel };
}
