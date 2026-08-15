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
          projectCap: 200,
          maxContextBlockBytes: 524_288,
          maxContextBlocksPerProject: 32,
          shutdownDrainMs: 30_000,
        },
        autoUpdateSkills: false,
        // Isolated per-process state dir — server tests must never touch the
        // developer's real ~/.mma/state (executions.db).
        stateDir: mkdtempSync(join(tmpdir(), 'mma-test-state-')),
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

/**
 * Options beyond the server config.
 *
 * `manifestSync` used to be hardcoded to `{ driftReport: () => [] }` here, which meant no test
 * COULD reach `GET /health`'s drift branch — the branch that reports missing, outdated, orphaned
 * or failed provisioning, and the only reason that endpoint does more than answer "alive". Four
 * tests covered the `ok` branch and none covered the other, because the helper made it
 * unreachable. The seam exists in `startServer` precisely so a test can pin the report; it just
 * had no way through.
 */
export interface TestServerOptions {
  /** Drift report `GET /health` reads. Defaults to none, i.e. `{ status: 'ok' }`. */
  manifestSync?: { driftReport(): DriftLike[] | Promise<DriftLike[]> };
}

/** Structural mirror of the handler's `DriftEntry` — `client` is a loose string there too. */
export interface DriftLike { skill: string; client: string; issue: 'missing' | 'outdated' | 'orphan' | 'failed' }

export async function startTestServer(
  overrides?: DeepPartial<ServerConfig>,
  opts?: TestServerOptions,
): Promise<TestServer> {
  const tokenDir = mkdtempSync(join(tmpdir(), 'mma-test-'));
  const tokenFile = join(tokenDir, 'auth-token');
  writeFileSync(tokenFile, DEFAULT_TEST_TOKEN + '\n', { mode: 0o600 });

  const config = buildTestConfig(tokenFile, overrides as Record<string, unknown> | undefined);
  const server = await startServer(config, opts?.manifestSync ?? { driftReport: () => [] });

  return {
    url: `http://127.0.0.1:${server.port}`,
    token: DEFAULT_TEST_TOKEN,
    stop: async () => { await server.stop(); },
  };
}
