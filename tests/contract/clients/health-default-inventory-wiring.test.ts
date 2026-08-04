/**
 * `GET /health`'s DEFAULT (non-injected) drift source is wired to
 * `provisioning/inventory.ts` via `provisioning/runtime-deps.ts` -- every
 * other server test overrides `manifestSync` with a fixed `{ driftReport: ()
 * => [] }` stub (see `tests/helpers/test-server.ts`), so nothing else in the
 * suite actually exercises this path. This test starts a real server the
 * same way `cli/serve.ts` does (no injected stub) and confirms the wiring
 * itself works end to end -- including that daemon-start recovery runs
 * without blocking startup.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ServerConfig } from '@zhixuan92/multi-model-agent-core';
import { startServer } from '../../../packages/server/src/http/server.js';

function buildConfig(): ServerConfig {
  const tokenDir = mkdtempSync(join(tmpdir(), 'mma-health-default-'));
  const tokenFile = join(tokenDir, 'auth-token');
  writeFileSync(tokenFile, 'test-token\n', { mode: 0o600 });
  return {
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
      // Isolated per-test state dir -- boot recovery reads/writes markers
      // here, never the developer's real ~/.mma/state.
      stateDir: mkdtempSync(join(tmpdir(), 'mma-health-default-state-')),
    },
  } as ServerConfig;
}

describe('contract: GET /health default inventory wiring', () => {
  it('reports ok with no injected manifestSync when no client is declared on', async () => {
    const server = await startServer(buildConfig());
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'ok' });
    } finally {
      await server.stop();
    }
  });
});
