// In-process HTTP harness for contract tests.
// Provider injection via MMA_TEST_PROVIDER_OVERRIDE env guard.

import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import type { MultiModelConfig, Provider } from '@zhixuan92/multi-model-agent-core';
import { __setCoreTestProviderOverride, __setCoreTestProviderOverrideMap } from '@zhixuan92/multi-model-agent-core';
import { startServer } from '@zhixuan92/multi-model-agent/server';

import { freezeClock } from './deterministic-clock.js';

export interface HarnessHandle {
  baseUrl: string;
  token: string;
  close(): Promise<void>;
}

export interface BootOptions {
  provider: Provider;
  cwd: string;
  /** Opt-in to JSONL diagnostic logging. Default false — tests should not
   *  pollute the user's global mma-YYYY-MM-DD.jsonl. The observability
   *  fixture sets this to true so it can read emitted events back from disk. */
  diagnosticsLog?: boolean;
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
  process.env.MMA_TEST_INTROSPECTION = '1';
  process.env.MMA_TEST_PROVIDER_OVERRIDE = '1';
  __setCoreTestProviderOverride(opts.provider);
  // Give standard and complex different canonical identities so R3 separation
  // (forbiddenIdentities) doesn't block fallback in single-provider test mode.
  // Each tier gets a config-wrapped copy differing only in baseUrl path suffix
  // so canonicalIdentity resolves to distinct normalizedEndpoints while model
  // names and all run behavior stay identical.
  const origBaseUrl = (opts.provider.config as Record<string, unknown>).baseUrl ?? 'http://mock.local';
  const standardProvider = { ...opts.provider, config: { ...opts.provider.config, baseUrl: `${origBaseUrl}/standard` } };
  const complexProvider = { ...opts.provider, config: { ...opts.provider.config, baseUrl: `${origBaseUrl}/complex` } };
  __setCoreTestProviderOverrideMap(new Map([['standard', standardProvider], ['complex', complexProvider]]));

  const token = randomUUID();
  const tokenPath = join(tmpdir(), `mma-test-token-${randomUUID()}`);
  writeFileSync(tokenPath, `${token}\n`, 'utf8');

  const config: MultiModelConfig = {
    agents: {
      standard: {
        type: 'codex',
        baseUrl: 'http://mock.local',
        apiKey: 'stub',
        model: 'mock',
      },
      complex: {
        type: 'codex',
        baseUrl: 'http://mock.local',
        apiKey: 'stub',
        model: 'mock',
      },
    },
    diagnostics: {
      log: opts.diagnosticsLog ?? false,
    },
    server: {
      bind: '127.0.0.1',
      port: 0,
      auth: { tokenFile: tokenPath },
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

  const server = await startServer(config, { driftReport: () => [] });
  const baseUrl = `http://127.0.0.1:${server.port}`;

  return {
    baseUrl,
    token,
    async close(): Promise<void> {
      await server.stop();
      __setCoreTestProviderOverride(null);
      __setCoreTestProviderOverrideMap(null);
      await unlink(tokenPath).catch(() => undefined);
    },
  };
}
