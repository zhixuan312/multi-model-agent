import { describe, it, expect } from 'vitest';
import { createProvider } from '@zhixuan92/multi-model-agent-core/providers/provider-factory';
import type { MultiModelConfig } from '@zhixuan92/multi-model-agent-core';

const config: MultiModelConfig = {
  agents: {
    standard: {
      type: 'codex',
      model: 'deepseek-r1',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
    },
    complex: {
      type: 'claude',
      model: 'claude-opus-4-6',
    },
  },
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
    stateDir: '/tmp/mma-test-state',
    autoUpdateSkills: false,
  },
  research: {
    brave: { apiKeys: [], timeoutMs: 8000, maxResultsPerQuery: 20, perCallBackoffMs: 250, minPerKeyIntervalMs: 1100 },
    builtinAdapters: { arxiv: true, semanticScholar: true, githubSearch: true, openalex: true, crossref: true, pubmed: true },
  },
};

describe('createProvider (1.0.0)', () => {
  it('creates a provider from the standard slot', () => {
    const p = createProvider('standard', config);
    expect(p.name).toBe('standard');
    expect(p.config.type).toBe('codex');
    expect(p.config.model).toBe('deepseek-r1');
  });

  it('creates a provider from the complex slot', () => {
    const p = createProvider('complex', config);
    expect(p.name).toBe('complex');
    expect(p.config.type).toBe('claude');
  });

  it('throws on invalid slot name', () => {
    expect(() => createProvider('nonexistent' as any, config)).toThrow();
  });
});
