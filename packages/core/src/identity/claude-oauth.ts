// packages/core/src/identity/claude-oauth.ts
//
// Reads Claude Code's OAuth bearer token for direct Anthropic HTTP calls in
// `packages/core/src/providers/claude.ts`. Codex auth is handled by the
// `codex` CLI subprocess (see `packages/core/src/providers/codex.ts:9`), not
// here — by design.
//
// Credentials live in different stores per platform:
//   - macOS  → Keychain, service "Claude Code-credentials" (JSON blob)
//   - Linux/ → ~/.claude/.credentials.json (mode 0600, same JSON shape)
//     other
//
// When the short-lived access token has expired (or is about to), the stored
// long-lived refresh token is exchanged for a new access token and the new
// credentials are persisted back to the same store, so unattended (headless)
// deployments on subscription auth stay authenticated across the ~8h
// access-token lifetime — on Linux servers as well as macOS.
import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync, renameSync, chmodSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export interface ClaudeOAuthCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
  subscriptionType?: string;
}

const KEYCHAIN_SERVICE = 'Claude Code-credentials';

// The access token is short-lived (~8h); the refresh token is long-lived
// (usable indefinitely until revoked). Refresh a bit before expiry to
// tolerate clock skew and avoid a token expiring mid-request.
const EXPIRY_SKEW_MS = 60_000;

// Public OAuth client id used by the Claude Code CLI. Overridable in case
// Anthropic rotates it. The token endpoint moved from console.anthropic.com
// to platform.claude.com; try the current host first, fall back for older
// environments.
const OAUTH_CLIENT_ID = process.env.CLAUDE_CODE_OAUTH_CLIENT_ID || '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const TOKEN_ENDPOINTS = [
  process.env.CLAUDE_CODE_OAUTH_TOKEN_URL,
  'https://platform.claude.com/v1/oauth/token',
  'https://console.anthropic.com/v1/oauth/token',
].filter((u): u is string => typeof u === 'string' && u.length > 0);

/** Injection seam for tests. Production uses real subprocess/fs/clock. */
export interface ClaudeOAuthDeps {
  exec: typeof execFileSync;
  now: () => number;
  readFile: (path: string) => string;
  /** Atomic, 0600 write (temp file + rename). */
  writeFile: (path: string, data: string) => void;
  homedir: () => string;
}

const defaultDeps: ClaudeOAuthDeps = {
  exec: execFileSync,
  now: () => Date.now(),
  readFile: (p) => readFileSync(p, 'utf8'),
  writeFile: (p, data) => {
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, data, { mode: 0o600 });
    try {
      chmodSync(tmp, 0o600);
    } catch {
      /* best effort */
    }
    renameSync(tmp, p);
  },
  homedir,
};

interface RefreshResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
}

/** A platform credential store: read/persist the `claudeAiOauth` JSON blob. */
interface CredentialStore {
  read(): string | null;
  persist(blob: string): boolean;
}

// ── macOS Keychain store ────────────────────────────────────────────────────

function keychainStore(deps: ClaudeOAuthDeps): CredentialStore {
  return {
    read() {
      try {
        const raw = deps
          .exec('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
          })
          .toString()
          .trim();
        return raw || null;
      } catch {
        return null;
      }
    },
    persist(blob) {
      // `security add-generic-password -U` updates the existing item, so it
      // needs the item's account name.
      let account: string | null = null;
      try {
        const attrs = deps
          .exec('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
          })
          .toString();
        const match = attrs.match(/"acct"<blob>="([^"]+)"/);
        account = match ? match[1] : null;
      } catch {
        return false;
      }
      if (!account) return false;
      try {
        // Note: the `security` CLI has no stdin option for the secret, so the
        // blob is briefly present in this subprocess's argv — an accepted
        // limitation of the tool (this is how Claude Code itself stores it).
        deps.exec('security', ['add-generic-password', '-U', '-a', account, '-s', KEYCHAIN_SERVICE, '-w', blob], {
          stdio: ['ignore', 'ignore', 'ignore'],
        });
        return true;
      } catch {
        return false;
      }
    },
  };
}

// ── Linux / non-macOS file store (~/.claude/.credentials.json) ───────────────

function credentialsFilePath(deps: ClaudeOAuthDeps): string {
  return join(deps.homedir(), '.claude', '.credentials.json');
}

function fileStore(deps: ClaudeOAuthDeps): CredentialStore {
  const path = credentialsFilePath(deps);
  return {
    read() {
      try {
        const raw = deps.readFile(path).trim();
        return raw || null;
      } catch {
        return null;
      }
    },
    persist(blob) {
      try {
        deps.writeFile(path, blob);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * Exchange the refresh token for a fresh access token. Synchronous by way of
 * a `curl` subprocess (matches the store-read style; keeps `getClaudeOAuth`
 * callable synchronously). The refresh token is passed on stdin, never as an
 * argv element, so it does not leak into the process list. Platform-agnostic —
 * `curl` is available on macOS and Linux. Returns null on any failure.
 */
function refreshAccessToken(exec: typeof execFileSync, refreshToken: string): RefreshResponse | null {
  const body = JSON.stringify({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: OAUTH_CLIENT_ID,
  });
  for (const url of TOKEN_ENDPOINTS) {
    try {
      const out = exec(
        'curl',
        ['-sS', '--fail', '-X', 'POST', url, '-H', 'Content-Type: application/json', '--data-binary', '@-'],
        { input: body, encoding: 'utf8', timeout: 15_000 },
      ).toString();
      const parsed = JSON.parse(out) as RefreshResponse;
      if (parsed && typeof parsed.access_token === 'string' && parsed.access_token.length > 0) return parsed;
    } catch {
      // try the next endpoint
    }
  }
  return null;
}

/**
 * Claude Code subscription token retrieval (4.2.3+), cross-platform.
 *
 * Reads Claude Code's OAuth credentials — from the macOS Keychain on darwin,
 * or `~/.claude/.credentials.json` on Linux/other — as the JSON blob
 * `{"claudeAiOauth": {"accessToken", "refreshToken", "expiresAt", ...}}`.
 *
 * When `expiresAt` is in the past (or within `EXPIRY_SKEW_MS`), the stored
 * refresh token is exchanged for a new access token, the new credentials are
 * written back to the same store, and the fresh credentials are returned.
 *
 * Returns null when:
 *   - The store has no entry (user never logged in to Claude Code)
 *   - The stored value isn't valid JSON or is missing the access token
 *   - The token is expired AND there is no refresh token, or the refresh
 *     request fails (caller should fall back to env var or config apiKey)
 */
export function getClaudeOAuth(overrides: Partial<ClaudeOAuthDeps> = {}): ClaudeOAuthCredentials | null {
  const deps: ClaudeOAuthDeps = { ...defaultDeps, ...overrides };
  const store = process.platform === 'darwin' ? keychainStore(deps) : fileStore(deps);

  const raw = store.read();
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
  const refreshToken = typeof oauth['refreshToken'] === 'string' ? oauth['refreshToken'] : undefined;
  const scopes = Array.isArray(oauth['scopes']) ? (oauth['scopes'] as string[]) : undefined;
  const subscriptionType = typeof oauth['subscriptionType'] === 'string' ? oauth['subscriptionType'] : undefined;

  const isExpired = expiresAt !== undefined && expiresAt < deps.now() + EXPIRY_SKEW_MS;

  if (isExpired) {
    // Access token has lapsed — refresh it using the long-lived refresh token.
    if (!refreshToken) return null;
    const refreshed = refreshAccessToken(deps.exec, refreshToken);
    if (!refreshed) return null;

    const newAccessToken = refreshed.access_token as string;
    const newRefreshToken = typeof refreshed.refresh_token === 'string' ? refreshed.refresh_token : refreshToken;
    const newExpiresAt = typeof refreshed.expires_in === 'number' ? deps.now() + refreshed.expires_in * 1000 : undefined;

    // Persist the rotated credentials so subsequent calls (and restarts) reuse
    // the fresh token instead of refreshing every time. Best effort: if
    // persistence fails, the returned token still authenticates this run.
    const updatedOauth = {
      ...oauth,
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      ...(newExpiresAt !== undefined && { expiresAt: newExpiresAt }),
    };
    store.persist(JSON.stringify({ ...wrapper, claudeAiOauth: updatedOauth }));

    return {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      ...(newExpiresAt !== undefined && { expiresAt: newExpiresAt }),
      ...(scopes && { scopes }),
      ...(subscriptionType && { subscriptionType }),
    };
  }

  return {
    accessToken,
    ...(refreshToken && { refreshToken }),
    ...(expiresAt !== undefined && { expiresAt }),
    ...(scopes && { scopes }),
    ...(subscriptionType && { subscriptionType }),
  };
}
