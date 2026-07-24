import { afterEach, describe, expect, it } from 'vitest';
import { writeFileSync, rmSync } from 'node:fs';
import { startServer } from '../../packages/server/src/http/server.js';
import type { MultiModelConfig } from '../../packages/core/src/types.js';

const CONFIG: MultiModelConfig = {
  agents: {
    standard: {
      type: 'codex',
      model: 'gpt-5',
      apiKeyEnv: 'OPENAI_API_KEY',
      baseUrl: 'https://api.openai.com/v1',
    },
    complex: {
      type: 'claude',
      model: 'claude-opus-4-8',
    },
    main: {
      type: 'claude',
      model: 'claude-sonnet-4-6',
      apiKey: 'sk-ant-inline',
    },
  },
  diagnostics: { log: false },
  server: {
    bind: '127.0.0.1',
    port: 0,
    auth: { tokenFile: '/tmp/mma-status-token' },
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
};

describe('GET /status auth metadata', () => {
  const servers: Array<{ stop(): Promise<void> }> = [];

  afterEach(async () => {
    delete process.env.OPENAI_API_KEY;
    rmSync(CONFIG.server.auth.tokenFile, { force: true });
    await Promise.all(servers.splice(0).map((server) => server.stop()));
  });

  it('reports per-tier provider type and auth mode using provider-factory resolution', async () => {
    process.env.OPENAI_API_KEY = 'sk-openai-env';

    const TOKEN = 'test-token';
    writeFileSync(CONFIG.server.auth.tokenFile, TOKEN + '\n', { mode: 0o600 });

    const server = await startServer(CONFIG, { driftReport: () => [] });
    servers.push(server);

    const res = await fetch(`http://127.0.0.1:${server.port}/status`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agents).toEqual({
      standard: { type: 'codex', mode: 'api-key' },
      complex: { type: 'claude', mode: 'oauth' },
      main: { type: 'claude', mode: 'api-key' },
    });
  });
});
