/**
 * Regression test for 3.1.0 → 3.1.1: startServe() must pass the full
 * MultiModelConfig (including agents) to startServer so tool endpoints
 * register real handlers instead of 503 'no_agent_config' stubs.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startServe } from '../../packages/server/src/cli/serve.js';
import type { MultiModelConfig } from '@zhixuan92/multi-model-agent-core';

describe('startServe agents pass-through (3.1.1 regression guard)', () => {
  it('tool endpoints do NOT return 503 no_agent_config when config.agents is populated', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'serve-agents-'));
    const tokenFile = join(dir, 'auth-token');
    writeFileSync(tokenFile, 'test-token\n', { mode: 0o600 });

    const config = {
      agents: {
        standard: { type: 'openai-compatible', model: 'm', baseUrl: 'http://x/v1', apiKey: 'k' },
        complex: { type: 'openai-compatible', model: 'm', baseUrl: 'http://x/v1', apiKey: 'k' },
      },
      defaults: {
        tools: 'full',
        timeoutMs: 60_000,
        maxCostUSD: 10,
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
          clarificationTimeoutMs: 60_000,
          maxContextBlocksPerProject: 100,
          shutdownDrainMs: 1_000,
        },
        autoUpdateSkills: false,
      },
      diagnostics: { log: false, verbose: false },
    } as unknown as MultiModelConfig;

    const handle = await startServe(config, (() => {}) as (code: number) => never);

    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/delegate?cwd=${encodeURIComponent(dir)}`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ tasks: [{ prompt: 'noop' }] }),
      });
      // Before the regression fix: 503 no_agent_config.
      // After: real handler accepts → 202 { batchId }. 400/422 also acceptable
      // (means tool handler registered; input validation caught something) but
      // NEVER 503 no_agent_config.
      expect(res.status).not.toBe(503);
      if (res.status !== 202) {
        const body = await res.clone().text();
        // If not 202, confirm the 503 code is at least not 'no_agent_config'.
        expect(body).not.toMatch(/no_agent_config/);
      }
    } finally {
      await handle.stop();
    }
  });
});
