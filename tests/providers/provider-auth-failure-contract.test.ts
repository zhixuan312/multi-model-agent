import { describe, it, expect, afterEach } from 'vitest';
import type { Provider } from '@zhixuan92/multi-model-agent-core';
import { createProvider } from '../../packages/core/src/providers/provider-factory.js';
import type { MultiModelConfig } from '../../packages/core/src/types.js';
import { ErrorCodeSchema } from '../../packages/core/src/error-codes.js';

function fakeProvider(result: { errorCode: string; errorMessage: string }): Provider {
  return {
    name: 'fake',
    config: { type: 'codex', model: 'gpt-5', baseUrl: 'https://api.openai.com/v1' },
    openSession: () => ({
      async send() {
        return {
          output: '',
          usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 },
          costUSD: 0,
          turns: 1,
          durationMs: 1,
          terminationReason: 'error' as const,
          errorCode: result.errorCode,
          errorMessage: result.errorMessage,
          filesWritten: [],
          usedShell: false,
        };
      },
      async close() {},
      getSessionId() { return null; },
    }),
  };
}

describe('provider auth failure rewrite', () => {
  afterEach(async () => {
    process.env.MMA_TEST_PROVIDER_OVERRIDE = '1';
    const { __setCoreTestProviderOverride, __setCoreTestProviderOverrideMap } = await import('../../packages/core/src/providers/provider-factory.js');
    __setCoreTestProviderOverride(null);
    __setCoreTestProviderOverrideMap(null);
    delete process.env.MMA_TEST_PROVIDER_OVERRIDE;
  });

  const config: MultiModelConfig = {
    agents: {
      standard: { type: 'codex', model: 'gpt-5' },
      complex: { type: 'claude', model: 'claude-opus-4-8' },
    },
    diagnostics: { log: false },
    server: {
      bind: '127.0.0.1',
      port: 7337,
      auth: { tokenFile: '~/.mma/auth-token' },
      limits: {
        maxBodyBytes: 10_485_760,
        batchTtlMs: 3_600_000,
        projectCap: 200,
        maxContextBlockBytes: 524_288,
        maxContextBlocksPerProject: 32,
        shutdownDrainMs: 30_000,
      },
      autoUpdateSkills: false,
    },
    research: {
      brave: { apiKeys: [], timeoutMs: 8000, maxResultsPerQuery: 20, perCallBackoffMs: 250, minPerKeyIntervalMs: 1100 },
      builtinAdapters: { arxiv: true, semanticScholar: true, githubSearch: true, openalex: true, crossref: true, pubmed: true },
    },
  };

  it('adds the new codes to the canonical schema', () => {
    expect(ErrorCodeSchema.parse('missing_credentials')).toBe('missing_credentials');
    expect(ErrorCodeSchema.parse('invalid_api_key')).toBe('invalid_api_key');
  });

  it('rewrites missing credentials using the selected tier and provider type', async () => {
    process.env.MMA_TEST_PROVIDER_OVERRIDE = '1';
    const { __setCoreTestProviderOverride } = await import('../../packages/core/src/providers/provider-factory.js');
    __setCoreTestProviderOverride(fakeProvider({
      errorCode: 'codex_error',
      errorMessage: 'Missing credentials. Run codex login or set OPENAI_API_KEY',
    }));

    const provider = createProvider('standard', config);
    const turn = await provider.openSession({
      wallClockDeadline: Date.now() + 10_000,
      abortSignal: new AbortController().signal,
      taskId: 't1',
      taskIndex: 0,
    }).send('test');

    expect(turn.errorCode).toBe('missing_credentials');
    expect(turn.errorMessage).toBe('standard tier codex provider is missing credentials');
  });
});
