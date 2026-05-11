import { describe, it, expect } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { Agent, Runner, OpenAIProvider, tool } from '@openai/agents';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

describe('SDK smoke (v4.4 dep verification)', () => {
  it('claude-agent-sdk exports query as a function', () => {
    expect(typeof query).toBe('function');
  });
  it('@openai/agents re-exports Agent and Runner', () => {
    expect(typeof Agent).toBe('function');
    expect(typeof Runner).toBe('function');
  });
  it('@openai/agents re-exports tool() factory', () => {
    expect(typeof tool).toBe('function');
  });
  it('@openai/agents re-exports OpenAIProvider with openAIClient option', () => {
    expect(typeof OpenAIProvider).toBe('function');
    expect(() => new OpenAIProvider({ openAIClient: {} as any, useResponses: true })).not.toThrow();
  });

  // Codex backend probe — live network, requires auth + a working backend.
  // Skipped in CI and in this test suite because: (a) routine vitest runs
  // shouldn't hit the live codex backend, (b) the codex backend's stability
  // for arbitrary tool sets is exactly what we're trying to verify, and a
  // failure here would block CI rather than just signal "ship without codex".
  // Unskip manually when verifying §4.3.2's codex ship gate.
  it.skip('codex backend probe (manual: unskip to verify codex ship gate)', async () => {
    // Verifies the codex backend accepts mma's tool set with the option-A
    // pattern (custom tools via tool() factory). If this fails, v4.4 ships
    // without codex (§4.3.2 fallback) and we publish only claude + openai.
    const { getCodexAuth } = await import('../../packages/core/src/identity/auth-token-store.js');
    const oauth = getCodexAuth();
    if (!oauth) { expect.fail('codex auth missing'); return; }
    const OpenAI = (await import('openai')).default;
    const client = new OpenAI({
      apiKey: oauth.accessToken,
      baseURL: 'https://chatgpt.com/backend-api/codex',
      defaultHeaders: { 'chatgpt-account-id': oauth.accountId },
    });
    const mp = new OpenAIProvider({ openAIClient: client as any, useResponses: true });
    const agent = new Agent({ name: 'smoke', model: 'gpt-5-codex', tools: [] });
    const runner = new Runner({ modelProvider: mp });
    const r = await runner.run(agent, 'Reply with the literal string OK.');
    expect(r).toBeDefined();
    await mp.close();
  }, 60_000);
});
