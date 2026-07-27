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
  /** Diagnostic sink for the refresh attempt/outcome (default: stderr). */
  log: (msg: string) => void;
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
  log: (msg) => { try { process.stderr.write(`[mma] claude-oauth-refresh: ${msg}\n`); } catch { /* ignore */ } },
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

// The refresh exchange runs in a Node subprocess (`process.execPath -e <script>`) rather than
// `curl`: `curl` is NOT guaranteed in a container (minimal Node base images omit it), which silently
// broke auto-refresh in-container (ISSUE-10) — the running Node binary always exists. It keeps
// `getClaudeOAuth` synchronous (no async ripple through provider.openSession). The POST body (which
// carries the refresh token) is passed on stdin, never as an argv element, so it never leaks into the
// process list. The script POSTs to each endpoint until one returns 2xx and prints that body; it exits
// non-zero when every endpoint fails, which surfaces here as a thrown error → logged, not swallowed.
const REFRESH_SUBPROCESS_SCRIPT =
  "const https=require('https');" +
  `const urls=${JSON.stringify(TOKEN_ENDPOINTS)};` +
  "let b='';process.stdin.on('data',d=>b+=d).on('end',()=>{(function n(i){" +
  "if(i>=urls.length){process.stderr.write('all endpoints failed');process.exit(3);}" +
  "let u;try{u=new URL(urls[i]);}catch{return n(i+1);}" +
  "const rq=https.request({hostname:u.hostname,port:u.port||443,path:u.pathname+u.search,method:'POST'," +
  "headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(b)},timeout:15000}," +
  "res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{" +
  "if(res.statusCode>=200&&res.statusCode<300){process.stdout.write(d);process.exit(0);}" +
  "else{process.stderr.write('HTTP '+res.statusCode+' from '+u.hostname);n(i+1);}});});" +
  "rq.on('error',e=>{process.stderr.write(String(e&&e.message||e));n(i+1);});" +
  "rq.on('timeout',()=>{rq.destroy();n(i+1);});rq.write(b);rq.end();})(0);});";

/**
 * Exchange the refresh token for a fresh access token via a synchronous Node subprocess (see
 * {@link REFRESH_SUBPROCESS_SCRIPT}). Returns null on any failure, logging the outcome so an
 * in-container refresh failure is diagnosable rather than a silent "token not found or expired".
 */
function refreshAccessToken(deps: ClaudeOAuthDeps, refreshToken: string): RefreshResponse | null {
  const body = JSON.stringify({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: OAUTH_CLIENT_ID,
  });
  try {
    const out = deps.exec(
      process.execPath,
      ['-e', REFRESH_SUBPROCESS_SCRIPT],
      { input: body, encoding: 'utf8', timeout: 20_000 },
    ).toString();
    const parsed = JSON.parse(out) as RefreshResponse;
    if (parsed && typeof parsed.access_token === 'string' && parsed.access_token.length > 0) {
      deps.log('access token expired → refreshed via refresh token');
      return parsed;
    }
    deps.log('refresh failed: response contained no access_token');
    return null;
  } catch (err) {
    deps.log(`refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
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
    if (!refreshToken) {
      deps.log('access token expired and no refresh token present — cannot refresh');
      return null;
    }
    const refreshed = refreshAccessToken(deps, refreshToken);
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
