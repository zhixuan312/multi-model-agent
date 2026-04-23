import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '@zhixuan92/multi-model-agent/server';
import type { ServerConfig } from '@zhixuan92/multi-model-agent-core';

const DEFAULT_TEST_TOKEN = 'test-token';

function buildTestConfig(tokenFile: string, overrides?: DeepPartial<ServerConfig>): ServerConfig {
  return deepMerge(
    {
      server: {
        bind: '127.0.0.1',
        port: 0,
        auth: { tokenFile },
        limits: {
          maxBodyBytes: 10_485_760,
          batchTtlMs: 3_600_000,
          idleProjectTimeoutMs: 1_800_000,
          clarificationTimeoutMs: 86_400_000,
          projectCap: 200,
          maxBatchCacheSize: 500,
          maxContextBlockBytes: 524_288,
          maxContextBlocksPerProject: 32,
          shutdownDrainMs: 30_000,
        },
      },
    } satisfies ServerConfig,
    overrides ?? {},
  ) as ServerConfig;
}

// Simple recursive merge for plain objects (not arrays)
function deepMerge(base: Record<string, unknown>, ...overrides: Record<string, unknown>[]): Record<string, unknown> {
  const result = { ...base };
  for (const override of overrides) {
    for (const key of Object.keys(override)) {
      const baseVal = result[key];
      const overrideVal = override[key];
      if (
        overrideVal !== null &&
        typeof overrideVal === 'object' &&
        !Array.isArray(overrideVal) &&
        baseVal !== null &&
        typeof baseVal === 'object' &&
        !Array.isArray(baseVal)
      ) {
        result[key] = deepMerge(
          baseVal as Record<string, unknown>,
          overrideVal as Record<string, unknown>,
        );
      } else if (overrideVal !== undefined) {
        result[key] = overrideVal;
      }
    }
  }
  return result;
}

type DeepPartial<T> = T extends object
  ? { [P in keyof T]?: DeepPartial<T[P]> }
  : T;

export interface TestServer {
  url: string;
  token: string;
  stop: () => Promise<void>;
}

export async function startTestServer(overrides?: DeepPartial<ServerConfig>): Promise<TestServer> {
  const tokenDir = mkdtempSync(join(tmpdir(), 'mmagent-test-'));
  const tokenFile = join(tokenDir, 'auth-token');
  writeFileSync(tokenFile, DEFAULT_TEST_TOKEN, { mode: 0o600 });

  const config = buildTestConfig(tokenFile, overrides as Record<string, unknown> | undefined);
  const server = await startServer(config);

  return {
    url: `http://127.0.0.1:${server.port}`,
    token: DEFAULT_TEST_TOKEN,
    stop: async () => { await server.stop(); },
  };
}
