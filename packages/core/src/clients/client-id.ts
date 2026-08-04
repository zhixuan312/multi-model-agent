// Canonical client identity — the single source of truth for which clients
// MMA declares support for. Every allowlist, config schema, and caller
// attribution surface derives from CLIENT_IDS rather than hand-maintaining
// its own copy of the roster.

/** The eight canonical clients MMA provisions for, in specification order. */
export const CLIENT_IDS = [
  'claude-code',
  'claude-desktop',
  'codex',
  'antigravity',
  'cursor',
  'vscode',
  'opencode',
  'windsurf',
] as const;

/** A canonical, declared client identity. */
export type ClientId = typeof CLIENT_IDS[number];

/** Explicit on/off declaration for a client in strict config. */
export type ClientState = 'on' | 'off';

/** The identity attributed to an inbound HTTP caller: a canonical client ID,
 *  Forge (MMA's own SDLC harness, not part of the declared client roster),
 *  or 'other' when the caller is unknown or sent no attribution header. */
export type CallerClient = ClientId | 'forge' | 'other';
