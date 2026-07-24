import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MultiModelConfig } from '@zhixuan92/multi-model-agent-core';
import { buildConfigureProviderHandler } from '../../packages/server/src/http/handlers/introspection/configure-provider.js';

describe('configure-provider persistence', () => {
  afterEach(() => {
    delete process.env.CUSTOM_OPENAI_KEY;
    vi.restoreAllMocks();
  });

  it('writes apiKeyEnv to config.json and never inlines the secret', async () => {
    process.env.CUSTOM_OPENAI_KEY = 'sk-live-secret';
    const dir = await mkdtemp(join(tmpdir(), 'mma-configure-provider-'));
    const configPath = join(dir, 'config.json');
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
    await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 'gpt-5' }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));

    const handler = buildConfigureProviderHandler(config, configPath);
    const req = {} as any;
    const resBody: Array<Buffer> = [];
    const res = {
      writeHead: () => undefined,
      end: (chunk?: string) => { if (chunk) resBody.push(Buffer.from(chunk)); },
    } as any;

    try {
      await handler(req, res, {}, {
        body: {
          tier: 'standard',
          provider: 'codex',
          model: 'gpt-5',
          dryRun: false,
          auth: { mode: 'api-key', apiKeyEnv: 'CUSTOM_OPENAI_KEY', baseUrl: 'https://api.openai.com/v1' },
        },
      } as any);

      const persisted = JSON.parse(await readFile(configPath, 'utf8'));
      expect(persisted.agents.standard.apiKeyEnv).toBe('CUSTOM_OPENAI_KEY');
      expect(persisted.agents.standard.apiKey).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
