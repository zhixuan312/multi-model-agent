// In-process HTTP harness for contract tests.
//
// Server API inspected from packages/server/src/http/server.ts on 2026-04-24:
//   - Export: `startServer(config: ServerConfig): Promise<RunningServer>`
//     (packages/server/src/http/server.ts:134)
//   - RunningServer has: { port, serverAddress, stop(), batchRegistry,
//     projectRegistry, serverStartedAt } (line 31)
//   - Listen: `server.listen(config.server.port, config.server.bind, resolve)`
//     with `port: 0` for OS-assigned port (line 186)
//   - Token loaded from `config.server.auth.tokenFile` (line 135) — so the
//     harness must write a temp token file, or we add a config knob that
//     accepts an inline token.
//   - Provider injection: NONE. createProvider(slot, config) in
//     packages/core/src/provider.ts:4 reads only `config.agents[slot]`, and
//     is called from execution-context.ts:62 via `providerFactory` inside
//     the ExecutionContext. There's no test seam today.
//
// Task 2 will add a narrow, env-guarded provider-injection seam (per the
// plan's Chapter 1 discipline: "Only if no provider-injection seam exists,
// add a test-only hook guarded by `process.env.MMAGENT_TEST_PROVIDER_OVERRIDE === '1'`").
// Until Task 2 lands that seam, `boot()` throws a clear error — the fixture
// is compile-ready but not yet runtime-ready. Contract tests that depend on
// the harness must use `it.todo` / `it.skip` (per global convention #12)
// until Task 2 completes.

import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import type { MultiModelConfig, Provider } from '@zhixuan92/multi-model-agent-core';
import { startServer } from '@zhixuan92/multi-model-agent/server';
import { __setTestProviderOverride } from '../../../packages/server/src/http/test-provider-override.js';
import { freezeClock } from './deterministic-clock.js';

export interface HarnessHandle {
  baseUrl: string;
  token: string;
  close(): Promise<void>;
}

export interface BootOptions {
  provider: Provider;
  cwd: string;
}

function installLoopbackOnlyFetch(): void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    const parsed = new URL(requestUrl);
    if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
      throw new Error(`contract test attempted network call: ${requestUrl}`);
    }
    return originalFetch(input, init);
  }) as typeof globalThis.fetch;
}

export async function boot(opts: BootOptions): Promise<HarnessHandle> {
  installLoopbackOnlyFetch();
  freezeClock();
  process.env.MMAGENT_TEST_INTROSPECTION = '1';
  process.env.MMAGENT_TEST_PROVIDER_OVERRIDE = '1';
  __setTestProviderOverride(opts.provider);

  const token = randomUUID();
  const tokenPath = join(tmpdir(), `mmagent-test-token-${randomUUID()}`);
  writeFileSync(tokenPath, `${token}\n`, 'utf8');

  const config: MultiModelConfig = {
    agents: {
      standard: {
        type: 'openai-compatible',
        baseUrl: 'http://mock.local',
        apiKey: 'stub',
        model: 'mock',
      },
      complex: {
        type: 'openai-compatible',
        baseUrl: 'http://mock.local',
        apiKey: 'stub',
        model: 'mock',
      },
    },
    defaults: {
      timeoutMs: 1_800_000,
      maxCostUSD: 10,
      tools: 'full',
      sandboxPolicy: 'cwd-only',
    },
    server: {
      bind: '127.0.0.1',
      port: 0,
      auth: { tokenFile: tokenPath },
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
      autoUpdateSkills: false,
    },
  };

  const server = await startServer(config);
  const baseUrl = `http://127.0.0.1:${server.port}`;

  return {
    baseUrl,
    token,
    async close(): Promise<void> {
      await server.stop();
      __setTestProviderOverride(null);
      await unlink(tokenPath).catch(() => undefined);
    },
  };
}
