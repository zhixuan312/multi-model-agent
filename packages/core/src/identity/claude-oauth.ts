// packages/core/src/identity/claude-oauth.ts
//
// Reads Claude Code's OAuth bearer token from macOS Keychain for direct
// Anthropic HTTP calls in `packages/core/src/providers/claude.ts`. Codex
// auth is handled by the `codex` CLI subprocess (see
// `packages/core/src/providers/codex.ts:9`), not here — by design. Token
// refresh is not implemented; expired tokens cause this function to
// return `null` and the provider falls back to other auth paths.
import { execFileSync } from 'node:child_process';

// execFileSync is injected (defaulting to the real one) so tests supply a fake
// WITHOUT `mock.module('child_process')`, which under Bun is process-global and
// sticky — it leaked into every later test that spawns codex/git subprocesses.
type ExecFileSyncFn = typeof execFileSync;

export interface ClaudeOAuthCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
  subscriptionType?: string;
}

/**
 * Claude Code subscription token retrieval (4.2.3+).
 *
 * Claude Code stores its OAuth credentials in the macOS Keychain under
 * service name `"Claude Code-credentials"`. The stored value is a JSON
 * blob: `{"claudeAiOauth": {"accessToken", "refreshToken", "expiresAt",
 * "scopes", "subscriptionType", ...}}`.
 *
 * Returns null when:
 *   - Not running on macOS (other platforms not yet supported — Claude
 *     Code stores credentials differently per platform)
 *   - The keychain entry doesn't exist (user hasn't logged in to
 *     Claude Code, or never had a Claude Max subscription)
 *   - The stored value isn't valid JSON or is missing the access token
 *   - The access token has already expired (caller should fall back to
 *     env var or config apiKey)
 *
 * Token refresh is not implemented in this version; if expiresAt is in
 * the past, returns null and the caller falls back. (Most subscription
 * tokens are valid for ~1 year, so refresh is rare in practice.)
 */
export function getClaudeOAuth(exec: ExecFileSyncFn = execFileSync): ClaudeOAuthCredentials | null {
  if (process.platform !== 'darwin') return null;
  let raw: string;
  try {
    raw = exec('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const wrapper = parsed as { claudeAiOauth?: Record<string, unknown> };
  const oauth = wrapper.claudeAiOauth;
  if (!oauth || typeof oauth !== 'object') return null;

  const accessToken = typeof oauth['accessToken'] === 'string' ? oauth['accessToken'] : undefined;
  if (!accessToken) return null;

  const expiresAt = typeof oauth['expiresAt'] === 'number' ? oauth['expiresAt'] : undefined;
  if (expiresAt !== undefined && expiresAt < Date.now()) return null;

  return {
    accessToken,
    ...(typeof oauth['refreshToken'] === 'string' && { refreshToken: oauth['refreshToken'] }),
    ...(expiresAt !== undefined && { expiresAt }),
    ...(Array.isArray(oauth['scopes']) && { scopes: oauth['scopes'] as string[] }),
    ...(typeof oauth['subscriptionType'] === 'string' && { subscriptionType: oauth['subscriptionType'] }),
  };
}
