// Canonical client identity — the single source of truth for which clients
// MMA declares support for. Every allowlist, config schema, and caller
// attribution surface derives from CLIENT_IDS rather than hand-maintaining
// its own copy of the roster.

/** The canonical clients MMA provisions for, in specification order. (Counting them in
 *  this sentence only creates a second place to update when one is added.) */
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

/**
 * The identity an Agent Plugins install declares.
 *
 * Deliberately NOT a member of {@link CLIENT_IDS}: that roster answers "which
 * clients does MMA provision for", and one AP artifact is loaded by many
 * clients, so it provisions for none of them specifically. It IS a real caller,
 * exactly like `forge` — and distinguishing "reached us through the standard"
 * from "unknown caller" is the whole point of attributing it, because that
 * number is what decides whether a bespoke writer can be retired.
 */
export const AGENT_PLUGIN_CLIENT = 'agent-plugin';

/** The identity attributed to an inbound HTTP caller: a canonical client ID,
 *  Forge (MMA's own SDLC harness, not part of the declared client roster),
 *  an Agent Plugins install, or 'other' when the caller is unknown or sent no
 *  attribution header. */
export type CallerClient = ClientId | 'forge' | typeof AGENT_PLUGIN_CLIENT | 'other';

/** Identities `mma mcp --client=<id>` accepts. A bridge speaks for a real
 *  client or for an AP artifact; it is never Forge (which calls HTTP directly)
 *  and never `other` (the daemon's fallback, not something a caller declares). */
export const MCP_BRIDGE_CLIENT_IDS = [...CLIENT_IDS, AGENT_PLUGIN_CLIENT] as const;
