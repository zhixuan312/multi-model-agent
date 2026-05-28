/**
 * Regression test for 3.1.0 → 3.1.1: startServe() must pass the full
 * MultiModelConfig (including agents) to startServer so tool endpoints
 * register real handlers instead of 503 'no_agent_config' stubs.
 */
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startServe } from '../../packages/server/src/cli/serve.js';
import { __setCoreTestProviderOverrideMap } from '@zhixuan92/multi-model-agent-core';
import { mockProvider } from '../contract/fixtures/mock-providers.js';
import type { MultiModelConfig } from '@zhixuan92/multi-model-agent-core';

// Use the provider-override seam with a fast in-memory fake instead of the real
// codex providers in `config.agents`. Previously this test dispatched a real
// /delegate task that spawned a codex subprocess and registered sessions in the
// module-level liveByTask map, then stopped the server WITHOUT awaiting — leaking
// that global state into later tests (safety-ceiling's live-session count,
// journal/batch dispatch). The fake completes deterministically and we drain the
// batch to terminal so liveByTask releases before stop().
let __prevOverrideEnv: string | undefined;
let __prevTelemetryEndpoint: string | undefined;
beforeAll(() => {
  __prevOverrideEnv = process.env.MMAGENT_TEST_PROVIDER_OVERRIDE;
  process.env.MMAGENT_TEST_PROVIDER_OVERRIDE = '1';
  // CRITICAL: startServe reads telemetry consent from the REAL ~/.multi-model
  // config and ships to the default hosted endpoint. Since this test now drains
  // the dispatched task to terminal (sealing the envelope → TelemetryUploader),
  // a non-empty endpoint would upload a junk mock ($0, model "custom") record to
  // the production backend on every run. Blank the endpoint so no uploader is
  // created at all (serve.ts: `if (telemetryEndpoint)` is then false).
  __prevTelemetryEndpoint = process.env.MMAGENT_TELEMETRY_ENDPOINT;
  process.env.MMAGENT_TELEMETRY_ENDPOINT = '';
});
afterEach(() => { __setCoreTestProviderOverrideMap(null); });
afterAll(() => {
  if (__prevOverrideEnv === undefined) delete process.env.MMAGENT_TEST_PROVIDER_OVERRIDE;
  else process.env.MMAGENT_TEST_PROVIDER_OVERRIDE = __prevOverrideEnv;
  if (__prevTelemetryEndpoint === undefined) delete process.env.MMAGENT_TELEMETRY_ENDPOINT;
  else process.env.MMAGENT_TELEMETRY_ENDPOINT = __prevTelemetryEndpoint;
});

describe('startServe agents pass-through (3.1.1 regression guard)', () => {
  it('tool endpoints do NOT return 503 no_agent_config when config.agents is populated', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'serve-agents-'));
    const tokenFile = join(dir, 'auth-token');
    writeFileSync(tokenFile, 'test-token\n', { mode: 0o600 });

    const fake = mockProvider({ sequence: [{ status: 'ok', output: 'done', filesWritten: [], workerStatus: 'done' }] });
    __setCoreTestProviderOverrideMap(new Map([['standard', fake], ['complex', fake]] as any));

    const config = {
      agents: {
        standard: { type: 'codex', model: 'm', baseUrl: 'http://x/v1', apiKey: 'k' },
        complex: { type: 'codex', model: 'm', baseUrl: 'http://x/v1', apiKey: 'k' },
      },
      defaults: {
        tools: 'full',
        timeoutMs: 60_000,
        sandboxPolicy: 'cwd-only',
      },
      server: {
        bind: '127.0.0.1',
        port: 0,
        auth: { tokenFile },
        limits: {
          projectCap: 10,
          idleProjectTimeoutMs: 600_000,
          batchTtlMs: 3_600_000,
          maxContextBlocksPerProject: 100,
          shutdownDrainMs: 1_000,
        },
        autoUpdateSkills: false,
      },
      diagnostics: { log: false },
    } as unknown as MultiModelConfig;

    const handle = await startServe(config, (() => {}) as (code: number) => never);
    const headers = {
      'X-MMA-Main-Model': 'claude-opus-4-7', 'X-MMA-Client': 'claude-code', Authorization: 'Bearer test-token',
      'content-type': 'application/json',
    };

    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/delegate?cwd=${encodeURIComponent(dir)}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ tasks: [{ prompt: 'noop', reviewPolicy: 'none' }] }),
      });
      // Before the regression fix: 503 no_agent_config.
      // After: real handler accepts → 202 { batchId }. 400/422 also acceptable
      // (means tool handler registered; input validation caught something) but
      // NEVER 503 no_agent_config.
      expect(res.status).not.toBe(503);
      if (res.status !== 202) {
        const body = await res.clone().text();
        expect(body).not.toMatch(/no_agent_config/);
      } else {
        // Drain to terminal so the dispatched task releases its liveByTask
        // sessions before stop() — no global-state leak into later tests.
        const { batchId } = (await res.clone().json()) as { batchId: string };
        for (let i = 0; i < 200; i++) {
          const poll = await fetch(`http://127.0.0.1:${handle.port}/batch/${batchId}`, { headers });
          if (poll.status === 200) break;
          await new Promise((r) => setTimeout(r, 20));
        }
      }
    } finally {
      await handle.stop();
    }
  });
});
