// Regression test for the bug where startServer hardcoded
// `createDiagnosticLogger({ enabled: false })`, ignoring the user's
// `diagnostics.log` config. Without this wiring the JSONL log file at
// ~/.multi-model/logs/mmagent-YYYY-MM-DD.jsonl never gets written, even
// though `diagnostics.log: true` is set and `mmagent logs` is willing to tail.

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
    ...(diagnostics ? { diagnostics } : {}),
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
}

function makeTokenFile(): string {
  const tokenPath = join(tmpdir(), `mmagent-diag-token-${randomUUID()}`);
  writeFileSync(tokenPath, `${randomUUID()}\n`, { mode: 0o600 });
  return tokenPath;
}

describe('startServer wires diagnostics.log into createDiagnosticLogger', () => {
  let cleanup: Array<() => void> = [];
  afterEach(() => {
    for (const fn of cleanup.splice(0)) fn();
    vi.restoreAllMocks();
  });

  it('passes enabled=true and logDir when diagnostics.log is set in config', async () => {
    const calls: Array<{ enabled: boolean; logDir?: string }> = [];
    vi.spyOn(core, 'createDiagnosticLogger').mockImplementation((options) => {
      calls.push({ enabled: options.enabled, logDir: options.logDir });
      // Return a no-op logger that satisfies the interface.
      return {
        startup: () => {},
        requestStart: () => {},
        requestComplete: () => {},
        error: () => {},
        shutdown: () => {},
        taskStarted: () => {},
        emit: () => {},
        expectedPath: () => undefined,
        sessionOpen: () => {},
        sessionClose: () => {},
        connectionRejected: () => {},
        requestRejected: () => {},
        projectCreated: () => {},
        projectEvicted: () => {},
        batchCompleted: () => {},
        batchFailed: () => {},
      };
    });

    const tokenPath = makeTokenFile();
    const logDir = mkdtempSync(join(tmpdir(), 'mmagent-diag-logs-'));
    cleanup.push(() => { rmSync(tokenPath, { force: true }); });
    cleanup.push(() => { rmSync(logDir, { recursive: true, force: true }); });

    const server = await startServer(buildConfig(tokenPath, { log: true, logDir }));
    cleanup.push(() => { void server.stop(); });

    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.enabled).toBe(true);
      expect(c.logDir).toBe(logDir);
    }
  });

  it('passes enabled=false when diagnostics is omitted (default)', async () => {
    const calls: Array<{ enabled: boolean }> = [];
    vi.spyOn(core, 'createDiagnosticLogger').mockImplementation((options) => {
      calls.push({ enabled: options.enabled });
      return {
        startup: () => {},
        requestStart: () => {},
        requestComplete: () => {},
        error: () => {},
        shutdown: () => {},
        taskStarted: () => {},
        emit: () => {},
        expectedPath: () => undefined,
        sessionOpen: () => {},
        sessionClose: () => {},
        connectionRejected: () => {},
        requestRejected: () => {},
        projectCreated: () => {},
        projectEvicted: () => {},
        batchCompleted: () => {},
        batchFailed: () => {},
      };
    });

    const tokenPath = makeTokenFile();
    cleanup.push(() => { rmSync(tokenPath, { force: true }); });

    const server = await startServer(buildConfig(tokenPath, undefined));
    cleanup.push(() => { void server.stop(); });

    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.enabled).toBe(false);
    }
  });
});
