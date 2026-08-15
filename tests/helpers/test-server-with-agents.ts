// tests/helpers/test-server-with-agents.ts
// Starts a test server with a full MultiModelConfig (agents + server config).
// Used by handler tests that need the real route handlers registered.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../packages/server/src/http/server.js';
import type { MultiModelConfig } from '@zhixuan92/multi-model-agent-core';

/**
 * Deliberately far below the production default of 500 so a cap test can fill it over HTTP
 * without hundreds of round trips. Exported because a test that restates `32` is asserting its
 * own literal: the number only proves the cap is READ from config if both sides come from here.
 */
export const TEST_CONTEXT_BLOCK_CAP = 32;


const DEFAULT_TEST_TOKEN = 'test-token';

/** Minimal MultiModelConfig with fake openai-compatible agents (will fail if actually invoked). */
/**
 * A DEEP partial, because the overrides are merged deeply.
 *
 * The signature was `Partial<MultiModelConfig>` — shallow — so the only override anyone actually
 * wants (`{ server: { limits: { … } } }`) did not typecheck, and the single call site passing one
 * reached for `as never`. That cast is the thing to avoid: the merge below used to be a shallow
 * spread that dropped `auth.tokenFile` along with the rest of the server block, and a type saying
 * "server must be complete" while the code deep-merges it is what let that pass review. The type
 * now describes the merge, and the cast is gone.
 */
type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export function buildTestAgentConfig(overrides: DeepPartial<MultiModelConfig> = {}): MultiModelConfig {
  const base = {
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
      // Required since 6.6.0: the daemon prices every run against this tier, and
      // `startServer` refuses a partially configured `agents` block.
      main: {
        type: 'codex',
        model: 'fake-model-main',
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
        maxContextBlocksPerProject: TEST_CONTEXT_BLOCK_CAP,
        shutdownDrainMs: 30_000,
      },
      // Isolated per-process state dir — server tests must never touch the
      // developer's real ~/.mma/state (executions.db).
      stateDir: mkdtempSync(join(tmpdir(), 'mma-test-state-')),
    },
  };

  // Deep merge at EVERY node, because the signature is a DeepPartial and must not lie.
  //
  // This spread `server` and `server.limits` by hand — which fixed the original bug (a top-level
  // spread silently dropped `auth.tokenFile`, `stateDir` and every other limit) but left `agents`
  // and `server.auth` replaced WHOLESALE. Two traps followed. Loud: `{agents:{standard:{…}}}`
  // typechecks and drops complex+main, throwing at `assertRunnable`. Silent and worse:
  // `{agents:{standard:{…},complex:{…},main:{…}}}` typechecks and yields tiers with no `type` —
  // and `assertRunnable` only checks that each tier KEY exists, never its contents, so the server
  // starts and the provider factory receives `type: undefined`.
  //
  // A recursive merge is the only version that matches what `DeepPartial` promises, and it
  // subsumes the hand-written cases rather than adding to them.
  return deepMerge(base as unknown as Record<string, unknown>, overrides as Record<string, unknown>) as unknown as MultiModelConfig;
}

/** Recursive merge; arrays and non-objects replace, plain objects merge. */
function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const key of Object.keys(override)) {
    const overrideVal = override[key];
    const baseVal = result[key];
    if (
      overrideVal !== null && typeof overrideVal === 'object' && !Array.isArray(overrideVal) &&
      baseVal !== null && typeof baseVal === 'object' && !Array.isArray(baseVal)
    ) {
      result[key] = deepMerge(baseVal as Record<string, unknown>, overrideVal as Record<string, unknown>);
    } else if (overrideVal !== undefined) {
      result[key] = overrideVal;
    }
  }
  return result;
}

export interface TestServerWithAgents {
  url: string;
  token: string;
  stop: () => Promise<void>;
  /** Shared ExecutionRegistry — exposed for test helpers that need to inject state. */
  executionRegistry: import('@zhixuan92/multi-model-agent-core').ExecutionRegistry;
  /** Shared ProjectRegistry — exposed for test helpers that need to access project state. */
  projectRegistry: import('../../packages/server/src/application/project-registry.js').ProjectRegistry;
}

export async function startTestServerWithAgents(
  overrides?: DeepPartial<MultiModelConfig>,
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
    executionRegistry: server.executionRegistry,
    projectRegistry: server.projectRegistry,
  };
}
