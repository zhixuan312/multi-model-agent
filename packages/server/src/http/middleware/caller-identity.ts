import type { IncomingMessage } from 'node:http';

const CLIENT_ALLOWLIST = new Set(['claude-code', 'cursor', 'codex-cli', 'gemini-cli']);

export type CallerClient = 'claude-code' | 'cursor' | 'codex-cli' | 'gemini-cli' | 'other';

export interface CallerIdentity {
  callerClient: CallerClient;
}

/** Default identity when no caller header is present. */
export const DEFAULT_IDENTITY: CallerIdentity = {
  callerClient: 'other',
};

export function resolveCallerIdentity(req: IncomingMessage): CallerIdentity {
  const rawClient = (req.headers['x-mma-client'] as string | undefined)?.toLowerCase().trim();

  const callerClient = (rawClient && CLIENT_ALLOWLIST.has(rawClient))
    ? (rawClient as CallerClient)
    : 'other';

  return { callerClient };
}
