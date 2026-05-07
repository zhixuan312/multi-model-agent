import type { IncomingMessage } from 'node:http';

const CLIENT_ALLOWLIST = new Set(['claude-code', 'cursor', 'codex-cli', 'gemini-cli']);

export type CallerClient = 'claude-code' | 'cursor' | 'codex-cli' | 'gemini-cli' | 'other';

export interface CallerIdentity {
  callerClient: CallerClient;
  /** Calling agent's model id (e.g., claude-opus-4-7). Sourced from the
   *  optional X-MMA-Main-Model header. Used as `mainModel` in wire
   *  telemetry so cost-delta-vs-main and family attribution can be
   *  computed. null when the caller didn't send the header. */
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
