import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as core from '@zhixuan92/multi-model-agent-core';
import { startServer } from '@zhixuan92/multi-model-agent/server';
import type { MultiModelConfig } from '@zhixuan92/multi-model-agent-core';

function buildConfig(tokenPath: string, diagnostics: MultiModelConfig['diagnostics']): MultiModelConfig {
  return {
    agents: {
      standard: { type: 'codex', baseUrl: 'http://mock.local', apiKey: 'stub', model: 'mock' },
      complex:  { type: 'codex', baseUrl: 'http://mock.local', apiKey: 'stub', model: 'mock' },
    },
    defaults: { timeoutMs: 1_800_000, tools: 'full', sandboxPolicy: 'cwd-only' },
    ...(diagnostics ? { diagnostics } : {}),
    server: {
      bind: '127.0.0.1', port: 0, auth: { tokenFile: tokenPath },
      limits: {
        maxBodyBytes: 10_485_760, batchTtlMs: 3_600_000, idleProjectTimeoutMs: 1_800_000,
        projectCap: 200, maxBatchCacheSize: 500, maxContextBlockBytes: 524_288,
        maxContextBlocksPerProject: 32, shutdownDrainMs: 30_000,
      },
      autoUpdateSkills: false,
    },
  };
}

function makeTokenFile(): string {
  const tokenPath = join(tmpdir(), `mmagent-locallog-${randomUUID()}`);
  writeFileSync(tokenPath, `${randomUUID()}\n`, { mode: 0o600 });
  return tokenPath;
}

describe('LocalLogSink gating on diagnostics.log (A1)', () => {
  let cleanup: Array<() => void> = [];
  afterEach(() => { for (const fn of cleanup.splice(0)) fn(); vi.restoreAllMocks(); });

  it('does NOT construct LocalLogSink when diagnostics.log is false', async () => {
    let constructed = 0;
    vi.spyOn(core, 'LocalLogSink').mockImplementation(function () {
      constructed++;
      return { name: 'local-log', emit: () => {} } as any;
    });
    const tokenPath = makeTokenFile();
    cleanup.push(() => { rmSync(tokenPath, { force: true }); });
    const server = await startServer(buildConfig(tokenPath, { log: false }));
    cleanup.push(() => { void server.stop(); });
    expect(constructed).toBe(0);
  });

  it('DOES construct LocalLogSink when diagnostics.log is true', async () => {
    let constructed = 0;
    vi.spyOn(core, 'LocalLogSink').mockImplementation(function () {
      constructed++;
      return { name: 'local-log', emit: () => {} } as any;
    });
    const tokenPath = makeTokenFile();
    cleanup.push(() => { rmSync(tokenPath, { force: true }); });
    const server = await startServer(buildConfig(tokenPath, { log: true }));
    cleanup.push(() => { void server.stop(); });
    expect(constructed).toBeGreaterThan(0);
  });
});
