/**
 * A PARTIALLY configured `agents` block must be refused at startup, by name.
 *
 * Why this is a distinct case from "no agents at all": an absent `agents` block
 * is a legitimate state (a provisioning-only daemon records a client roster
 * before any model is chosen) and yields a server with no tool handlers. A block
 * that declares some tiers and not others is a broken config, and the only
 * honest response is to say which tier is missing.
 *
 * What went wrong before this guard: `startServer` narrowed to `RunnableConfig`
 * by checking only that `agents` was truthy, then cast. `mma serve` was safe
 * because it calls `assertRunnable` first, but every direct caller of
 * `startServer` was not. The runtime then read `agents.main.model` while pricing
 * a FINISHED run, so the missing tier surfaced as an unhandled TypeError after
 * the work was already paid for, with nothing naming the config as the cause.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from '../../packages/server/src/http/server.js';
import type { MultiModelConfig, ServerConfig } from '@zhixuan92/multi-model-agent-core';

function buildConfig(agents: Record<string, unknown> | undefined): ServerConfig {
  const dir = mkdtempSync(join(tmpdir(), 'partial-agents-'));
  const tokenFile = join(dir, 'auth-token');
  writeFileSync(tokenFile, 'test-token\n', { mode: 0o600 });
  const tier = { type: 'codex', model: 'm', baseUrl: 'http://localhost:1/v1', apiKey: 'k' };
  return {
    ...(agents ? { agents: Object.fromEntries(Object.keys(agents).map((k) => [k, tier])) } : {}),
    server: {
      bind: '127.0.0.1',
      port: 0,
      auth: { tokenFile },
      limits: {
        projectCap: 10,
        batchTtlMs: 3_600_000,
        maxContextBlocksPerProject: 100,
        shutdownDrainMs: 1_000,
      },
      stateDir: mkdtempSync(join(tmpdir(), 'mma-test-state-')),
      autoUpdateSkills: false,
    },
    diagnostics: { log: false },
  } as unknown as ServerConfig;
}

describe('startServer refuses a partially configured agents block', () => {
  it('names the missing main tier — the shape every pre-6.6.0 config has', async () => {
    await expect(startServer(buildConfig({ standard: 1, complex: 1 }), { driftReport: () => [] }))
      .rejects.toThrow(/agents\.main is not configured/);
  });

  it('names a missing worker tier too', async () => {
    await expect(startServer(buildConfig({ standard: 1, main: 1 }), { driftReport: () => [] }))
      .rejects.toThrow(/agents\.complex is not configured/);
  });

  it('still starts with NO agents block at all, so provisioning-only stays possible', async () => {
    const server = await startServer(buildConfig(undefined), { driftReport: () => [] });
    expect(server.port).toBeGreaterThan(0);
    await server.stop();
  });

  it('starts when all three tiers are declared', async () => {
    const server = await startServer(
      buildConfig({ standard: 1, complex: 1, main: 1 }),
      { driftReport: () => [] },
    );
    expect(server.port).toBeGreaterThan(0);
    await server.stop();
  });
});

// Type-only reference so the MultiModelConfig import is not unused when the
// helper's cast changes shape.
export type _Config = MultiModelConfig;
