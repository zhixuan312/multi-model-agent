/**
 * tests/cli/serve.test.ts
 *
 * Acceptance tests for Task 9.1 — CLI entry + serve subcommand.
 *
 * Required scope (per plan):
 * 1. `mmagent serve` starts a server on the configured port and responds to GET /health
 * 2. Graceful shutdown on SIGTERM
 * 3. Graceful shutdown on SIGINT  ← plan implementation detail, kept here
 *
 * No extra coverage (no --help, --version, invalid-config tests — those belong
 * in later CLI tasks). All temp filesystem use mkdtempSync; no real home dirs touched.
 */
import { describe, it, expect, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Minimal MultiModelConfig with stub agents (satisfies multiModelConfigSchema). */
function minimalConfig(bind = '127.0.0.1', port = 0): object {
  return {
    agents: {
      standard: {
        type: 'openai-compatible',
        baseUrl: 'https://api.example.com/v1',
        model: 'test-model',
      },
      complex: {
        type: 'openai-compatible',
        baseUrl: 'https://api.example.com/v1',
        model: 'test-model',
      },
    },
    defaults: {},
    server: {
      bind,
      port,
      auth: { tokenFile: '~/.multi-model/auth-token' },
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
    },
  };
}

/** Path to the built CLI entry point. */
function cliPath(): string {
  const thisDir = fileURLToPath(import.meta.url);
  return join(thisDir, '..', '..', 'packages', 'server', 'dist', 'cli', 'index.js');
}

function writeConfig(dir: string, cfg: object): string {
  const configPath = join(dir, 'mmagent.config.json');
  writeFileSync(configPath, JSON.stringify(cfg), 'utf-8');
  return configPath;
}

/**
 * Waits for the CLI process to print "[mmagent] listening on host:port"
 * and returns the base URL.
 */
async function waitForServerReady(
  child: ChildProcess,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const chunks: Buffer[] = [];
  child.stderr?.on('data', (c: Buffer) => chunks.push(c));

  while (Date.now() < deadline) {
    const output = Buffer.concat(chunks).toString('utf8');
    const match = output.match(/\[mmagent\] listening on (.+:\d+)/);
    if (match) return `http://${match[1]}`;
    if (child.exitCode !== null) break;
    await new Promise(r => setTimeout(r, 50));
  }

  child.kill('SIGKILL');
  const finalOutput = Buffer.concat(chunks).toString('utf8');
  throw new Error(
    `Server did not start within ${timeoutMs}ms.\nstderr:\n${finalOutput}\nexitCode: ${child.exitCode}`,
  );
}

// ─── Test 1: start + health ──────────────────────────────────────────────────

describe('serve subcommand', () => {
  it('starts a server on the configured port and responds to GET /health', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mmagent-serve-test-'));
    const configPath = writeConfig(dir, minimalConfig('127.0.0.1', 0));

    const child = spawn('node', [cliPath(), 'serve', '--config', configPath], {
      stdio: 'pipe',
      env: { ...process.env },
    });

    try {
      const url = await waitForServerReady(child, 8000);
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+/);

      // Health endpoint — unauthenticated, no cwd parameter
      const res = await fetch(`${url}/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    } finally {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => { child.on('close', () => resolve()); });
    }
  });

  // ─── Test 2: SIGTERM graceful shutdown ────────────────────────────────────

  it('shuts down gracefully on SIGTERM', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mmagent-serve-test-'));
    const configPath = writeConfig(dir, minimalConfig('127.0.0.1', 0));

    const child = spawn('node', [cliPath(), 'serve', '--config', configPath], {
      stdio: 'pipe',
      env: { ...process.env },
    });

    const stderrChunks: Buffer[] = [];
    child.stderr?.on('data', (c: Buffer) => stderrChunks.push(c));

    try {
      await waitForServerReady(child, 8000);

      child.kill('SIGTERM');

      const [code, signal] = await new Promise<[number | null, string | null]>((resolve) => {
        child.on('exit', (c, s) => resolve([c, s]));
      });

      expect(code).toBe(0);
      expect(signal).toBeNull();

      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      expect(stderr).toContain('shutting down gracefully');
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  });

  // ─── Test 3: SIGINT graceful shutdown ─────────────────────────────────────
  // The plan implementation installs handlers for both SIGTERM and SIGINT.
  // We verify SIGINT here so the signal-handler scope of serve.ts is exercised.

  it('shuts down gracefully on SIGINT', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mmagent-serve-test-'));
    const configPath = writeConfig(dir, minimalConfig('127.0.0.1', 0));

    const child = spawn('node', [cliPath(), 'serve', '--config', configPath], {
      stdio: 'pipe',
      env: { ...process.env },
    });

    const stderrChunks: Buffer[] = [];
    child.stderr?.on('data', (c: Buffer) => stderrChunks.push(c));

    try {
      await waitForServerReady(child, 8000);

      child.kill('SIGINT');

      const [code, signal] = await new Promise<[number | null, string | null]>((resolve) => {
        child.on('exit', (c, s) => resolve([c, s]));
      });

      expect(code).toBe(0);
      expect(signal).toBeNull();

      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      expect(stderr).toContain('shutting down gracefully');
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  });
});
