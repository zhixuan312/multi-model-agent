import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'child_process';
import { getClaudeOAuth } from '../../packages/core/src/identity/claude-oauth.js';

const mockExec = execFileSync as ReturnType<typeof vi.fn>;

// Fixed timestamps so the test does not depend on Date.now().
const FAR_FUTURE_MS = Date.UTC(2100, 0, 1);
const FAR_PAST_MS = Date.UTC(2000, 0, 1);

const originalPlatform = process.platform;

function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

/**
 * Route mocked `execFileSync` calls by their command/args:
 *  - `security find-generic-password ... -w` → the Keychain blob
 *  - `security find-generic-password` (no -w) → item attributes (account)
 *  - `curl ...` → the OAuth refresh response
 *  - `security add-generic-password -U ...` → persist (records the write)
 */
function routeExec(opts: {
  blob: string;
  account?: string | Error;
  refresh?: unknown | Error;
  onWrite?: (blob: string) => void;
}): void {
  mockExec.mockImplementation((cmd: string, args: string[], options?: { input?: string }) => {
    if (cmd === 'security' && args[0] === 'find-generic-password' && args.includes('-w')) {
      return opts.blob;
    }
    if (cmd === 'security' && args[0] === 'find-generic-password') {
      if (opts.account instanceof Error) throw opts.account;
      return `class: "genp"\n    "acct"<blob>="${opts.account ?? 'zhangzhixuan'}"\n    "svce"<blob>="Claude Code-credentials"\n`;
    }
    if (cmd === 'curl') {
      if (opts.refresh instanceof Error) throw opts.refresh;
      // expose the request body (should carry the refresh token via stdin)
      routeExec.lastCurlInput = options?.input;
      return JSON.stringify(opts.refresh);
    }
    if (cmd === 'security' && args[0] === 'add-generic-password') {
      const w = args.indexOf('-w');
      opts.onWrite?.(w >= 0 ? args[w + 1] : '');
      return '';
    }
    return '';
  });
}
routeExec.lastCurlInput = undefined as string | undefined;

describe('getClaudeOAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPlatform('darwin');
    routeExec.lastCurlInput = undefined;
  });

  afterEach(() => {
    setPlatform(originalPlatform);
  });

  it('case 1: returns null on non-darwin platforms', () => {
    setPlatform('linux');
    expect(getClaudeOAuth()).toBeNull();
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('case 2: returns null when the keychain lookup throws (entry missing)', () => {
    mockExec.mockImplementation(() => {
      throw new Error('security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.');
    });
    expect(getClaudeOAuth()).toBeNull();
  });

  it('case 3: returns null when keychain payload is not valid JSON', () => {
    mockExec.mockReturnValue('not-json-at-all');
    expect(getClaudeOAuth()).toBeNull();
  });

  it('case 4: returns null when JSON parses but has no accessToken', () => {
    mockExec.mockReturnValue(
      JSON.stringify({ claudeAiOauth: { refreshToken: 'r', expiresAt: FAR_FUTURE_MS } }),
    );
    expect(getClaudeOAuth()).toBeNull();
  });

  it('case 5: returns null when the token is expired AND there is no refresh token', () => {
    mockExec.mockReturnValue(
      JSON.stringify({ claudeAiOauth: { accessToken: 'tok-expired', expiresAt: FAR_PAST_MS } }),
    );
    expect(getClaudeOAuth()).toBeNull();
  });

  it('case 6: returns the credentials when token is valid and unexpired (no refresh)', () => {
    mockExec.mockReturnValue(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'tok-valid',
          refreshToken: 'r-valid',
          expiresAt: FAR_FUTURE_MS,
          scopes: ['user:inference'],
          subscriptionType: 'max',
        },
      }),
    );
    const creds = getClaudeOAuth();
    expect(creds?.accessToken).toBe('tok-valid');
    expect(creds?.refreshToken).toBe('r-valid');
    expect(creds?.expiresAt).toBe(FAR_FUTURE_MS);
    // never touched curl / write
    expect(mockExec).toHaveBeenCalledTimes(1);
  });

  it('case 7: refreshes an expired token via the refresh token and persists the new one', () => {
    const writes: string[] = [];
    routeExec({
      blob: JSON.stringify({
        claudeAiOauth: {
          accessToken: 'tok-expired',
          refreshToken: 'sk-ant-ort01-OLD',
          expiresAt: FAR_PAST_MS,
          scopes: ['user:inference'],
          subscriptionType: 'max',
        },
      }),
      account: 'zhangzhixuan',
      refresh: { token_type: 'Bearer', access_token: 'sk-ant-oat01-NEW', refresh_token: 'sk-ant-ort01-NEW', expires_in: 28_800 },
      onWrite: (b) => writes.push(b),
    });

    const before = Date.now();
    const creds = getClaudeOAuth();

    expect(creds?.accessToken).toBe('sk-ant-oat01-NEW');
    expect(creds?.refreshToken).toBe('sk-ant-ort01-NEW');
    expect(creds?.expiresAt).toBeGreaterThan(before + 28_800 * 1000 - 5_000);
    expect(creds?.scopes).toEqual(['user:inference']);
    expect(creds?.subscriptionType).toBe('max');

    // the refresh token went over stdin, not argv
    const curlCall = mockExec.mock.calls.find((c) => c[0] === 'curl');
    expect(curlCall?.[1]).not.toContain('sk-ant-ort01-OLD');
    expect(routeExec.lastCurlInput).toContain('sk-ant-ort01-OLD');
    expect(routeExec.lastCurlInput).toContain('"grant_type":"refresh_token"');

    // persisted the rotated credentials back to the keychain
    expect(writes).toHaveLength(1);
    const persisted = JSON.parse(writes[0]) as { claudeAiOauth: { accessToken: string; refreshToken: string } };
    expect(persisted.claudeAiOauth.accessToken).toBe('sk-ant-oat01-NEW');
    expect(persisted.claudeAiOauth.refreshToken).toBe('sk-ant-ort01-NEW');
  });

  it('case 8: returns null when the token is expired and the refresh request fails', () => {
    routeExec({
      blob: JSON.stringify({
        claudeAiOauth: { accessToken: 'tok-expired', refreshToken: 'r', expiresAt: FAR_PAST_MS },
      }),
      refresh: new Error('curl: (22) The requested URL returned error: 401'),
    });
    expect(getClaudeOAuth()).toBeNull();
  });

  it('case 9: still returns the refreshed token even if persisting to the keychain fails', () => {
    routeExec({
      blob: JSON.stringify({
        claudeAiOauth: { accessToken: 'tok-expired', refreshToken: 'r-old', expiresAt: FAR_PAST_MS },
      }),
      account: new Error('security: attributes read failed'), // no account → skip persist
      refresh: { access_token: 'tok-new', refresh_token: 'r-new', expires_in: 28_800 },
    });
    const creds = getClaudeOAuth();
    expect(creds?.accessToken).toBe('tok-new');
    // reused the old refresh token in the returned creds is NOT expected; response provided a new one
    expect(creds?.refreshToken).toBe('r-new');
  });

  it('case 10: keeps the old refresh token when the refresh response omits a new one', () => {
    routeExec({
      blob: JSON.stringify({
        claudeAiOauth: { accessToken: 'tok-expired', refreshToken: 'r-keep', expiresAt: FAR_PAST_MS },
      }),
      account: 'zhangzhixuan',
      refresh: { access_token: 'tok-new', expires_in: 28_800 }, // no refresh_token in response
    });
    const creds = getClaudeOAuth();
    expect(creds?.accessToken).toBe('tok-new');
    expect(creds?.refreshToken).toBe('r-keep');
  });
});

// ── Linux / non-macOS: reads ~/.claude/.credentials.json (same blob shape) ────
describe('getClaudeOAuth (Linux / file store)', () => {
  const HOME = '/home/svc';
  const CREDS_PATH = `${HOME}/.claude/.credentials.json`;

  beforeEach(() => {
    vi.clearAllMocks();
    setPlatform('linux');
  });
  afterEach(() => setPlatform(originalPlatform));

  function linuxDeps(over: {
    blob?: string | Error;
    refresh?: unknown | Error;
    now?: number;
    onWrite?: (path: string, data: string) => void;
  }) {
    const exec = vi.fn((cmd: string, _args: string[], options?: { input?: string }) => {
      if (cmd === 'curl') {
        if (over.refresh instanceof Error) throw over.refresh;
        return JSON.stringify(over.refresh);
      }
      return '';
    });
    const readFile = vi.fn((p: string) => {
      expect(p).toBe(CREDS_PATH);
      if (over.blob instanceof Error) throw over.blob;
      return over.blob ?? '';
    });
    const writeFile = vi.fn((p: string, data: string) => over.onWrite?.(p, data));
    return {
      deps: {
        exec: exec as unknown as typeof import('child_process').execFileSync,
        now: () => over.now ?? Date.now(),
        readFile,
        writeFile,
        homedir: () => HOME,
      },
      exec,
      readFile,
      writeFile,
    };
  }

  const FULL_BLOB = (over: Record<string, unknown>) =>
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-OLD',
        refreshToken: 'sk-ant-ort01-OLD',
        expiresAt: FAR_FUTURE_MS,
        refreshTokenExpiresAt: 1787155594671,
        scopes: ['user:inference', 'user:profile'],
        subscriptionType: 'max',
        rateLimitTier: 'default_claude_max_20x',
        ...over,
      },
    });

  it('L1: reads the file and returns credentials when valid/unexpired (no refresh, no write)', () => {
    const { deps, exec, writeFile } = linuxDeps({ blob: FULL_BLOB({}) });
    const creds = getClaudeOAuth(deps);
    expect(creds?.accessToken).toBe('sk-ant-oat01-OLD');
    expect(creds?.refreshToken).toBe('sk-ant-ort01-OLD');
    expect(creds?.subscriptionType).toBe('max');
    expect(exec).not.toHaveBeenCalled(); // never shells out on the happy path
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('L2: refreshes an expired token, persists the FULL wrapper back to the file, preserves extra fields', () => {
    let written: { path?: string; data?: string } = {};
    const { deps } = linuxDeps({
      blob: FULL_BLOB({ expiresAt: FAR_PAST_MS }),
      refresh: { access_token: 'sk-ant-oat01-NEW', refresh_token: 'sk-ant-ort01-NEW', expires_in: 28_800 },
      onWrite: (path, data) => (written = { path, data }),
    });
    const before = Date.now();
    const creds = getClaudeOAuth(deps);

    expect(creds?.accessToken).toBe('sk-ant-oat01-NEW');
    expect(creds?.refreshToken).toBe('sk-ant-ort01-NEW');
    expect(creds?.expiresAt).toBeGreaterThan(before + 28_800 * 1000 - 5_000);

    // persisted the whole file (wrapper), rotated tokens, extra fields untouched
    expect(written.path).toBe(CREDS_PATH);
    const persisted = JSON.parse(written.data!) as { claudeAiOauth: Record<string, unknown> };
    expect(persisted.claudeAiOauth.accessToken).toBe('sk-ant-oat01-NEW');
    expect(persisted.claudeAiOauth.refreshToken).toBe('sk-ant-ort01-NEW');
    expect(persisted.claudeAiOauth.refreshTokenExpiresAt).toBe(1787155594671);
    expect(persisted.claudeAiOauth.rateLimitTier).toBe('default_claude_max_20x');
    expect(persisted.claudeAiOauth.subscriptionType).toBe('max');
  });

  it('L3: returns null when the credentials file does not exist', () => {
    const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const { deps } = linuxDeps({ blob: err });
    expect(getClaudeOAuth(deps)).toBeNull();
  });

  it('L4: returns null when expired and the refresh request fails', () => {
    const { deps, writeFile } = linuxDeps({
      blob: FULL_BLOB({ expiresAt: FAR_PAST_MS }),
      refresh: new Error('curl: (22) 401'),
    });
    expect(getClaudeOAuth(deps)).toBeNull();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('L5: still returns the refreshed token even if the file write fails (best effort)', () => {
    const { deps } = linuxDeps({
      blob: FULL_BLOB({ expiresAt: FAR_PAST_MS }),
      refresh: { access_token: 'tok-new', refresh_token: 'r-new', expires_in: 28_800 },
      onWrite: () => {
        throw new Error('EACCES');
      },
    });
    const creds = getClaudeOAuth(deps);
    expect(creds?.accessToken).toBe('tok-new');
  });
});
