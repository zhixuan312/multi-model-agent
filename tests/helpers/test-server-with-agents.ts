// tests/helpers/test-server-with-agents.ts
// Starts a test server with a full MultiModelConfig (agents + server config).
// Used by handler tests that need the real route handlers registered.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../packages/server/src/http/server.js';
import type { MultiModelConfig } from '@zhixuan92/multi-model-agent-core';

const DEFAULT_TEST_TOKEN = 'test-token';

/** Minimal MultiModelConfig with fake openai-compatible agents (will fail if actually invoked). */
export function buildTestAgentConfig(overrides: Partial<MultiModelConfig> = {}): MultiModelConfig {
  return {
    agents: {
      standard: {
        type: 'codex',
        model: 'fake-model',
        baseUrl: 'http://localhost:1/v1',  // invalid — tests never actually call it
      },
      complex: {
        type: 'codex',
        model: 'fake-model-complex',
        baseUrl: 'http://localhost:1/v1',
      },
    },
    server: {
      bind: '127.0.0.1',
      port: 0,
      auth: { tokenFile: '' },  // overridden below
      limits: {
        maxBodyBytes: 10_485_760,
        batchTtlMs: 3_600_000,
        projectCap: 200,
        maxContextBlockBytes: 524_288,
        maxContextBlocksPerProject: 32,
        shutdownDrainMs: 30_000,
      },
    },
    ...overrides,
  } as MultiModelConfig;
}

export interface TestServerWithAgents {
  url: string;
  token: string;
  stop: () => Promise<void>;
  /** Shared TaskRegistry — exposed for test helpers that need to inject state. */
  taskRegistry: import('@zhixuan92/multi-model-agent-core').TaskRegistry;
  /** Shared ProjectRegistry — exposed for test helpers that need to access project state. */
  projectRegistry: import('../../packages/server/src/http/project-registry.js').ProjectRegistry;
}

export async function startTestServerWithAgents(
  overrides?: Partial<MultiModelConfig>,
): Promise<TestServerWithAgents> {
  const tokenDir = mkdtempSync(join(tmpdir(), 'mma-handler-test-'));
  const tokenFile = join(tokenDir, 'auth-token');
  writeFileSync(tokenFile, DEFAULT_TEST_TOKEN + '\n', { mode: 0o600 });

  const config = buildTestAgentConfig(overrides);
  config.server!.auth.tokenFile = tokenFile;

  // startServer accepts ServerConfig but we pass MultiModelConfig (superset).
  // The server checks for .agents to decide whether to register tool handlers.
  const server = await startServer(
    config as unknown as import('@zhixuan92/multi-model-agent-core').ServerConfig,
    { driftReport: () => [] },
  );

  return {
    url: `http://127.0.0.1:${server.port}`,
    token: DEFAULT_TEST_TOKEN,
    stop: async () => { await server.stop(); },
    taskRegistry: server.taskRegistry,
    projectRegistry: server.projectRegistry,
  };
}
