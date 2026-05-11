// packages/core/src/identity/auth-token-store.ts
// Unified OAuth + API-key store per architecture.md:65.
// Replaces the previous claude-oauth.ts + codex-oauth.ts split.
//
// Each provider's auth flow is namespaced under a const:
//   - claudeOAuth.getClaudeAuth() — env var (ANTHROPIC_API_KEY) +
//     macOS Keychain fallback for Claude Code subscription tokens
//   - codexOAuth.getCodexAuth() — reads ~/.codex/auth.json with chmod warning
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

// ── Claude ───────────────────────────────────────────────────────────────
export interface ClaudeAuth {
  apiKey?: string;
  useOAuth: boolean;
}

export interface ClaudeOAuthCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
  subscriptionType?: string;
}

export function getClaudeAuth(): ClaudeAuth {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  return {
    apiKey: apiKey || undefined,
    useOAuth: !apiKey,
  };
}

/**
 * Claude Code subscription token retrieval (4.2.3+).
 *
 * Claude Code stores its OAuth credentials in the macOS Keychain under
 * service name `"Claude Code-credentials"`. The stored value is a JSON
 * blob: `{"claudeAiOauth": {"accessToken", "refreshToken", "expiresAt",
 * "scopes", "subscriptionType", ...}}`.
 *
 * This is the equivalent of `getCodexAuth()` (which reads
 * `~/.codex/auth.json`): when the user has a valid Claude Max
 * subscription via Claude Code, mma can dispatch to Anthropic's API
 * using the OAuth bearer token instead of requiring an API key in
 * config or `ANTHROPIC_API_KEY` env.
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
export function getClaudeOAuth(): ClaudeOAuthCredentials | null {
  if (process.platform !== 'darwin') return null;
  let raw: string;
  try {
    raw = execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], {
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

export const claudeOAuth = { getClaudeAuth, getClaudeOAuth };

// ── Codex ────────────────────────────────────────────────────────────────
const CODEX_AUTH_PATH = () => path.join(os.homedir(), '.codex', 'auth.json');

interface CodexAuthFile {
  tokens?: {
    access_token?: string;
    account_id?: string;
  };
}

export interface CodexAuth {
  accessToken: string;
  accountId: string;
}

// Track which paths we have already warned about so getCodexAuth() can be
// called repeatedly (it is, on every sub-agent dispatch) without spamming
// stderr with the same chmod warning.
const warnedPaths = new Set<string>();

function warnIfWorldReadable(authPath: string): void {
  // Permission bits are POSIX-only. On Windows, mode bits are not meaningful.
  if (process.platform === 'win32') return;
  if (warnedPaths.has(authPath)) return;
  try {
    const stats = fs.statSync(authPath);
    const groupOrOtherReadable = (stats.mode & 0o077) !== 0;
    if (groupOrOtherReadable) {
      warnedPaths.add(authPath);
      const mode = (stats.mode & 0o777).toString(8);
      // eslint-disable-next-line no-console
      console.warn(
        `[multi-model-agent] WARNING: ${authPath} has permissions 0${mode} ` +
          `and is readable by other users on this system. Run \`chmod 600 ${authPath}\` ` +
          `to restrict access to your Codex OAuth token.`,
      );
    }
  } catch {
    // statSync should not normally fail here (we just confirmed existsSync),
    // but if it does there's nothing useful to warn about.
  }
}

export function getCodexAuth(): CodexAuth | null {
  const authPath = CODEX_AUTH_PATH();
  if (!fs.existsSync(authPath)) return null;

  warnIfWorldReadable(authPath);

  try {
    const raw: CodexAuthFile = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
    if (!raw.tokens?.access_token || !raw.tokens?.account_id) return null;
    return {
      accessToken: raw.tokens.access_token,
      accountId: raw.tokens.account_id,
    };
  } catch {
    return null;
  }
}

export const codexOAuth = { getCodexAuth };
