import { describe, it, expect, vi } from 'vitest';

describe('getClaudeAuth', () => {
  it('returns apiKey and useOAuth=false when ANTHROPIC_API_KEY is set', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test-key');
    const { getClaudeAuth } = await import('../../packages/core/src/auth/claude-oauth.js');
    const auth = getClaudeAuth();
    expect(auth.apiKey).toBe('sk-ant-test-key');
    expect(auth.useOAuth).toBe(false);
  });

  it('returns apiKey=undefined and useOAuth=true when ANTHROPIC_API_KEY is not set', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const { getClaudeAuth } = await import('../../packages/core/src/auth/claude-oauth.js');
    const auth = getClaudeAuth();
    expect(auth.apiKey).toBeUndefined();
    expect(auth.useOAuth).toBe(true);
  });
});
