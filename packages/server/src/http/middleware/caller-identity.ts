import type { IncomingMessage } from 'node:http';

const CLIENT_ALLOWLIST = new Set(['claude-code', 'cursor', 'codex-cli', 'gemini-cli']);
const SKILL_ALLOWLIST = new Set([
  'mma-delegate', 'mma-audit', 'mma-review', 'mma-verify', 'mma-debug',
  'mma-execute-plan', 'mma-retry', 'mma-investigate',
  'mma-context-blocks', 'mma-clarifications',
]);

export type CallerClient = 'claude-code' | 'cursor' | 'codex-cli' | 'gemini-cli' | 'other';
export type CallerSkill = string;

export interface CallerIdentity {
  callerClient: CallerClient;
  callerSkill: CallerSkill;
}

/** Default identity when no caller headers are present. */
export const DEFAULT_IDENTITY: CallerIdentity = {
  callerClient: 'other',
  callerSkill: 'direct',
};

export function resolveCallerIdentity(req: IncomingMessage): CallerIdentity {
  const rawClient = (req.headers['x-mma-client'] as string | undefined)?.toLowerCase().trim();
  const rawSkill = (req.headers['x-mma-caller-skill'] as string | undefined)?.toLowerCase().trim();

  const callerClient = (rawClient && CLIENT_ALLOWLIST.has(rawClient))
    ? (rawClient as CallerClient)
    : 'other';

  let callerSkill: CallerSkill;
  if (!rawSkill) {
    callerSkill = 'direct';
  } else {
    callerSkill = SKILL_ALLOWLIST.has(rawSkill) ? rawSkill : 'other';
  }

  return { callerClient, callerSkill };
}
