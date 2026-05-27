import { describe, it, expect, vi, beforeEach, afterEach } from 'bun:test';

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

describe('getClaudeOAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPlatform('darwin');
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
      JSON.stringify({
        claudeAiOauth: {
          refreshToken: 'r',
          expiresAt: FAR_FUTURE_MS,
        },
      }),
    );
    expect(getClaudeOAuth()).toBeNull();
  });

  it('case 5: returns null when token is expired', () => {
    mockExec.mockReturnValue(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'tok-expired',
          expiresAt: FAR_PAST_MS,
        },
      }),
    );
    expect(getClaudeOAuth()).toBeNull();
  });

  it('case 6: returns the credentials when token is valid and unexpired', () => {
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
    expect(creds).not.toBeNull();
    expect(creds?.accessToken).toBe('tok-valid');
    expect(creds?.refreshToken).toBe('r-valid');
    expect(creds?.expiresAt).toBe(FAR_FUTURE_MS);
    expect(creds?.scopes).toEqual(['user:inference']);
    expect(creds?.subscriptionType).toBe('max');
  });
});
