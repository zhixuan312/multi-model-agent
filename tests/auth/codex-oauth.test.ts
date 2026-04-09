import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('codex-oauth', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mma-auth-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('reads valid Codex OAuth token', async () => {
    const { getCodexAuth } = await import('../../src/auth/codex-oauth.js');
    const codexDir = path.join(tmpDir, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(path.join(codexDir, 'auth.json'), JSON.stringify({
      tokens: {
        access_token: 'test-token-123',
        account_id: 'acct-456',
      },
    }));

    const auth = getCodexAuth();

    expect(auth).not.toBeNull();
    expect(auth!.accessToken).toBe('test-token-123');
    expect(auth!.accountId).toBe('acct-456');
  });

  it('returns null when no auth file exists', async () => {
    const { getCodexAuth } = await import('../../src/auth/codex-oauth.js');
    const auth = getCodexAuth();
    expect(auth).toBeNull();
  });

  it('returns null when tokens are missing', async () => {
    const { getCodexAuth } = await import('../../src/auth/codex-oauth.js');
    const codexDir = path.join(tmpDir, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(path.join(codexDir, 'auth.json'), JSON.stringify({}));

    const auth = getCodexAuth();
    expect(auth).toBeNull();
  });
});
