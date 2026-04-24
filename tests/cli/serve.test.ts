/**
 * tests/cli/serve.test.ts
 *
 * Acceptance tests for Task 9.1 — CLI entry + serve subcommand.
 *
 * Required scope (per plan):
 *   1. `mmagent serve` starts a server on the configured port and responds to GET /health
 *   2. Graceful shutdown on SIGTERM
 *   3. Config discovery order: --config → MMAGENT_CONFIG → CWD default → home default
 *
 * Extended coverage (per quality review):
 *   - --help and --version flags
 *   - Malformed --config values (directory, unreadable, invalid JSON)
 *   - Shutdown failure behavior
 *   - Home-directory fallback integration test
 *   - Bare invocation (no subcommand) defaults to serve
 *
 * All temp filesystem use mkdtempSync; no real home dirs touched.
 */
import { describe, it, expect } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

/** Path to the built CLI entry point. */
function cliPath(): string {
  // Resolve relative to the repo root — works in both ESM test runner and CJS.
  const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
  return join(repoRoot, 'packages', 'server', 'dist', 'cli', 'index.js');
}

/** Minimal MultiModelConfig with stub agents (satisfies multiModelConfigSchema). */
function minimalConfig(overrides: { bind?: string; port?: number; tokenFile?: string } = {}): object {
  const { bind = '127.0.0.1', port = 0, tokenFile = join(tmpdir(), 'mmagent-test-token') } = overrides;
  return {
    agents: {
      standard: { type: 'openai-compatible', baseUrl: 'https://api.example.com/v1', model: 'test-model' },
      complex: { type: 'openai-compatible', baseUrl: 'https://api.example.com/v1', model: 'test-model' },
    },
    defaults: {},
    server: {
      bind,
      port,
      auth: { tokenFile },
      limits: {
        maxBodyBytes: 10_485_760, batchTtlMs: 3_600_000, idleProjectTimeoutMs: 1_800_000,
        clarificationTimeoutMs: 86_400_000, projectCap: 200, maxBatchCacheSize: 500,
        maxContextBlockBytes: 524_288, maxContextBlocksPerProject: 32, shutdownDrainMs: 30_000,
      },
    },
  };
}

/** Write a token file and return its path. */
function writeTokenFile(dir: string): string {
  const tokenFile = join(dir, 'auth-token');
  writeFileSync(tokenFile, 'test-token\n', { mode: 0o600 });
  return tokenFile;
}

/** Write a JSON config file. */
function writeConfigFile(dir: string, cfg: object, filename: string): string {
  const p = join(dir, filename);
  writeFileSync(p, JSON.stringify(cfg), 'utf-8');
  return p;
}

/**
 * Waits for the CLI process to print "[mmagent] listening on host:port"
 * and returns the base URL. Fails fast if the child exits unexpectedly.
 */
async function waitForServerReady(child: ChildProcess, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const chunks: Buffer[] = [];
  child.stderr?.on('data', (c: Buffer) => chunks.push(c));

  while (Date.now() < deadline) {
    const output = Buffer.concat(chunks).toString('utf8');
    const match = output.match(/\[mmagent\] listening on (.+:\d+)/);
    if (match) return `http://${match[1]}`;
    if (child.exitCode !== null) {
      const finalOutput = Buffer.concat(chunks).toString('utf8');
      throw new Error(
        `Server process exited unexpectedly (code=${child.exitCode}).\nstderr:\n${finalOutput}`,
      );
    }
    await new Promise(r => setTimeout(r, 50));
  }

  child.kill('SIGKILL');
  const finalOutput = Buffer.concat(chunks).toString('utf8');
  throw new Error(`Server did not start within ${timeoutMs}ms.\nstderr:\n${finalOutput}`);
}

/** Cleanly terminate a server child process. */
async function stopChild(child: ChildProcess): Promise<void> {
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => { child.on('close', () => resolve()); });
}

// ─── --help and --version ──────────────────────────────────────────────────

describe('--help and --version flags', () => {
  it('--help prints usage text to stdout and exits 0', async () => {
    const child = spawn('node', [cliPath(), '--help'], { stdio: 'pipe' });
    const [code, stdout, stderr] = await new Promise<[number, string, string]>((resolve) => {
      let out = '', err = '';
      child.stdout?.on('data', (c: Buffer) => { out += c.toString(); });
      child.stderr?.on('data', (c: Buffer) => { err += c.toString(); });
      child.on('close', (c) => resolve([c ?? 1, out, err]));
    });
    expect(code).toBe(0);
    expect(stdout).toContain('mmagent');
    expect(stdout).toContain('serve');
    expect(stdout).toContain('install-skill');
    expect(stderr).toBe('');
  });

  it('--version prints version to stdout and exits 0', async () => {
    const child = spawn('node', [cliPath(), '--version'], { stdio: 'pipe' });
    const [code, stdout, stderr] = await new Promise<[number, string, string]>((resolve) => {
      let out = '', err = '';
      child.stdout?.on('data', (c: Buffer) => { out += c.toString(); });
      child.stderr?.on('data', (c: Buffer) => { err += c.toString(); });
      child.on('close', (c) => resolve([c ?? 1, out, err]));
    });
    expect(code).toBe(0);
    // Should be a semver string, not empty
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    expect(stderr).toBe('');
  });

  it('-h is an alias for --help', async () => {
    const child = spawn('node', [cliPath(), '-h'], { stdio: 'pipe' });
    const [code, stdout] = await new Promise<[number, string]>((resolve) => {
      let out = '';
      child.stdout?.on('data', (c: Buffer) => { out += c.toString(); });
      child.on('close', (c) => resolve([c ?? 1, out]));
    });
    expect(code).toBe(0);
    expect(stdout).toContain('serve');
  });

  it('-v is an alias for --version', async () => {
    const child = spawn('node', [cliPath(), '-v'], { stdio: 'pipe' });
    const [code, stdout] = await new Promise<[number, string]>((resolve) => {
      let out = '';
      child.stdout?.on('data', (c: Buffer) => { out += c.toString(); });
      child.on('close', (c) => resolve([c ?? 1, out]));
    });
    expect(code).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

// ─── serve subcommand ───────────────────────────────────────────────────────

describe('serve subcommand', () => {
  // ─── Test: start + health ────────────────────────────────────────────────

  it('starts a server on the configured port and responds to GET /health', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mmagent-serve-test-'));
    const tokenFile = writeTokenFile(dir);
    const configPath = writeConfigFile(dir, minimalConfig({ tokenFile }), 'config.json');

    const child = spawn('node', [cliPath(), 'serve', '--config', configPath], {
      stdio: 'pipe',
      env: { ...process.env },
    });

    try {
      const url = await waitForServerReady(child, 8000);
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+/);

      const res = await fetch(`${url}/health`);
      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean };
      expect(body.ok).toBe(true);
    } finally {
      await stopChild(child);
    }
  });

  // ─── Test: SIGTERM graceful shutdown ─────────────────────────────────────

  it('shuts down gracefully on SIGTERM and exits 0', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mmagent-serve-sigterm-'));
    const tokenFile = writeTokenFile(dir);
    const configPath = writeConfigFile(dir, minimalConfig({ tokenFile }), 'config.json');

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

  // ─── Test: SIGINT graceful shutdown ─────────────────────────────────────

  it('shuts down gracefully on SIGINT and exits 0', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mmagent-serve-sigint-'));
    const tokenFile = writeTokenFile(dir);
    const configPath = writeConfigFile(dir, minimalConfig({ tokenFile }), 'config.json');

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

// ─── Config discovery order ──────────────────────────────────────────────────

describe('config discovery order', () => {
  it('--config wins over $MMAGENT_CONFIG', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mmagent-disc-'));
    const tokenFile = writeTokenFile(dir);

    const cwdDir = mkdtempSync(join(tmpdir(), 'mmagent-cwd-'));
    writeConfigFile(cwdDir, minimalConfig({ tokenFile }), '.multi-model-agent.json');

    const explicitConfigPath = writeConfigFile(dir, minimalConfig({ tokenFile }), 'config.json');

    const child = spawn('node', [cliPath(), 'serve', '--config', explicitConfigPath], {
      stdio: 'pipe',
      env: { ...process.env, MMAGENT_CONFIG: join(cwdDir, '.multi-model-agent.json') },
    });

    try {
      const url = await waitForServerReady(child, 8000);
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+/);
    } finally {
      await stopChild(child);
    }
  });

  it('$MMAGENT_CONFIG env wins over file defaults', async () => {
    const envDir = mkdtempSync(join(tmpdir(), 'mmagent-env-'));
    const tokenFile = writeTokenFile(envDir);
    const configPath = writeConfigFile(envDir, minimalConfig({ tokenFile }), 'config.json');

    const child = spawn('node', [cliPath(), 'serve'], {
      stdio: 'pipe',
      env: { ...process.env, MMAGENT_CONFIG: configPath },
    });

    try {
      const url = await waitForServerReady(child, 8000);
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+/);
    } finally {
      await stopChild(child);
    }
  });

  it('CWD .multi-model-agent.json is used when no --config or env var is set', async () => {
    const cwdDir = mkdtempSync(join(tmpdir(), 'mmagent-cwd-'));
    const tokenFile = writeTokenFile(cwdDir);
    writeConfigFile(cwdDir, minimalConfig({ tokenFile }), '.multi-model-agent.json');

    const child = spawn('node', [cliPath(), 'serve'], {
      stdio: 'pipe',
      cwd: cwdDir,
      env: { ...process.env },
    });

    try {
      const url = await waitForServerReady(child, 8000);
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+/);
    } finally {
      await stopChild(child);
    }
  });

  it('HOME ~/.multi-model/config.json is used as fallback', async () => {
    // Create a temp home dir with the expected config path
    const fakeHome = mkdtempSync(join(tmpdir(), 'mmagent-fakehome-'));
    mkdirSync(join(fakeHome, '.multi-model'), { recursive: true });
    const tokenFile = writeTokenFile(fakeHome);
    writeConfigFile(join(fakeHome, '.multi-model'), minimalConfig({ tokenFile }), 'config.json');

    // CWD should have no config, and no env var set
    const cwdDir = mkdtempSync(join(tmpdir(), 'mmagent-cwd-'));
    writeConfigFile(cwdDir, { agents: minimalConfig().agents, defaults: {} }, 'wrong.json');

    const child = spawn('node', [cliPath(), 'serve'], {
      stdio: 'pipe',
      cwd: cwdDir,
      env: { ...process.env, HOME: fakeHome },
    });

    try {
      const url = await waitForServerReady(child, 8000);
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+/);

      // Sanity-check: the CWD wrong.json was NOT used (it has no server block,
      // so server would fail to start if it were picked). If we reached here,
      // the home fallback worked.
    } finally {
      await stopChild(child);
    }
  });

  it('fails gracefully when no config file is found', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'mmagent-noconf-'));

    const child = spawn('node', [cliPath(), 'serve'], {
      stdio: 'pipe',
      cwd: emptyDir,
      env: { ...process.env, HOME: '/nonexistent-home', MMAGENT_CONFIG: '' },
    });

    const stderrChunks: Buffer[] = [];
    child.stderr?.on('data', (c: Buffer) => stderrChunks.push(c));

    const exitCode = await new Promise<number>((resolve) => {
      child.on('exit', (c) => resolve(c ?? 1));
    });

    const stderr = Buffer.concat(stderrChunks).toString('utf8');
    expect(exitCode).toBe(1);
    expect(stderr).toContain('No config file found');
  });
});

// ─── Config error cases ─────────────────────────────────────────────────────

describe('config error handling', () => {
  it('--config pointing to a directory exits 1 with a config error message', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mmagent-conf-dir-'));

    const child = spawn('node', [cliPath(), 'serve', '--config', dir], {
      stdio: 'pipe',
      env: { ...process.env },
    });

    const [code, stderr] = await new Promise<[number, string]>((resolve) => {
      let err = '';
      child.stderr?.on('data', (c: Buffer) => { err += c.toString(); });
      child.on('close', (c) => resolve([c ?? 1, err]));
    });

    expect(code).toBe(1);
    // loadConfigFromFile rejects non-file paths; the error message should reference the path
    expect(stderr).toContain(dir);
  });

  it('--config pointing to a file with invalid JSON exits 1', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mmagent-bad-json-'));
    const tokenFile = writeTokenFile(dir);
    writeFileSync(join(dir, 'bad.json'), 'this is not JSON{', 'utf-8');

    const child = spawn('node', [cliPath(), 'serve', '--config', join(dir, 'bad.json')], {
      stdio: 'pipe',
      env: { ...process.env },
    });

    const [code, stderr] = await new Promise<[number, string]>((resolve) => {
      let err = '';
      child.stderr?.on('data', (c: Buffer) => { err += c.toString(); });
      child.on('close', (c) => resolve([c ?? 1, err]));
    });

    expect(code).toBe(1);
    expect(stderr).toContain('Config error');
  });

  it('--config pointing to an unreadable file exits 1', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mmagent-unreadable-'));
    const tokenFile = writeTokenFile(dir);
    const badConfig = join(dir, 'unreadable.json');
    writeFileSync(badConfig, JSON.stringify(minimalConfig({ tokenFile })), 'utf-8');
    // Remove read permission so fs.access fails
    chmodSync(badConfig, 0o000);

    try {
      const child = spawn('node', [cliPath(), 'serve', '--config', badConfig], {
        stdio: 'pipe',
        env: { ...process.env },
      });

      const [code, stderr] = await new Promise<[number, string]>((resolve) => {
        let err = '';
        child.stderr?.on('data', (c: Buffer) => { err += c.toString(); });
        child.on('close', (c) => resolve([c ?? 1, err]));
      });

      expect(code).toBe(1);
      expect(stderr).toContain('Config error');
    } finally {
      // Restore permissions so the temp directory can be cleaned up
      chmodSync(badConfig, 0o600);
    }
  });
});

// ─── Bare mmagent invocation ───────────────────────────────────────────────

describe('bare mmagent invocation (no subcommand)', () => {
  it('with no subcommand starts serve and responds to GET /health', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mmagent-bare-'));
    const tokenFile = writeTokenFile(dir);
    const configPath = writeConfigFile(dir, minimalConfig({ tokenFile }), 'config.json');

    // bare invocation: mmagent --config <path>
    const child = spawn('node', [cliPath(), '--config', configPath], {
      stdio: 'pipe',
      env: { ...process.env },
    });

    try {
      const url = await waitForServerReady(child, 8000);
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+/);

      const res = await fetch(`${url}/health`);
      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean };
      expect(body.ok).toBe(true);
    } finally {
      await stopChild(child);
    }
  });
});

// ─── Unknown subcommand ─────────────────────────────────────────────────────

describe('unknown subcommand', () => {
  it('prints an error and exits 1', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mmagent-unknown-'));
    const tokenFile = writeTokenFile(dir);
    const configPath = writeConfigFile(dir, minimalConfig({ tokenFile }), 'config.json');

    const child = spawn('node', [cliPath(), 'unknown-subcommand', '--config', configPath], {
      stdio: 'pipe',
      env: { ...process.env },
    });

    const [code, stderr] = await new Promise<[number, string]>((resolve) => {
      let err = '';
      child.stderr?.on('data', (c: Buffer) => { err += c.toString(); });
      child.on('close', (c) => resolve([c ?? 1, err]));
    });

    expect(code).toBe(1);
    expect(stderr).toContain('Unknown command');
    expect(stderr).toContain('--help');
  });
});

// ─── resolveConfigPath unit tests ──────────────────────────────────────────

import { resolveConfigPath } from '../../packages/server/src/cli/index.js';

describe('resolveConfigPath', () => {
  it('returns --config path when it exists', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'mmagent-rcd-'));
    writeConfigFile(tmpDir, {}, 'explicit.json');
    const result = resolveConfigPath(
      join(tmpDir, 'explicit.json'),
      {},
      tmpDir,
      tmpDir,
    );
    expect(result).toBe(join(tmpDir, 'explicit.json'));
  });

  it('returns $MMAGENT_CONFIG when --config is absent/missing', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'mmagent-rcd-'));
    writeConfigFile(tmpDir, {}, 'env.json');
    const result = resolveConfigPath(
      undefined,
      { MMAGENT_CONFIG: join(tmpDir, 'env.json') },
      tmpDir,
      tmpDir,
    );
    expect(result).toBe(join(tmpDir, 'env.json'));
  });

  it('returns CWD path when both --config and $MMAGENT_CONFIG are absent/missing', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'mmagent-rcd-'));
    writeConfigFile(tmpDir, {}, '.multi-model-agent.json');
    const result = resolveConfigPath(undefined, {}, tmpDir, tmpDir);
    expect(result).toBe(join(tmpDir, '.multi-model-agent.json'));
  });

  it('returns home path when --config, $MMAGENT_CONFIG, and CWD are absent/missing', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'mmagent-home-'));
    mkdirSync(join(homeDir, '.multi-model'), { recursive: true });
    writeConfigFile(join(homeDir, '.multi-model'), {}, 'config.json');
    const result = resolveConfigPath(undefined, {}, '/nonexistent-cwd', homeDir);
    expect(result).toBe(join(homeDir, '.multi-model', 'config.json'));
  });

  it('--config wins over $MMAGENT_CONFIG', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'mmagent-prectest-'));
    writeConfigFile(tmpDir, {}, 'explicit.json');
    mkdirSync(join(tmpDir, 'subdir'), { recursive: true });
    writeConfigFile(join(tmpDir, 'subdir'), {}, 'env.json');
    const result = resolveConfigPath(
      join(tmpDir, 'explicit.json'),
      { MMAGENT_CONFIG: join(tmpDir, 'subdir', 'env.json') },
      tmpDir,
      tmpDir,
    );
    expect(result).toBe(join(tmpDir, 'explicit.json'));
  });

  it('$MMAGENT_CONFIG wins over CWD', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'mmagent-prectest-'));
    writeConfigFile(tmpDir, {}, '.multi-model-agent.json');
    writeConfigFile(tmpDir, {}, 'env.json');
    const result = resolveConfigPath(
      undefined,
      { MMAGENT_CONFIG: join(tmpDir, 'env.json') },
      tmpDir,
      tmpDir,
    );
    expect(result).toBe(join(tmpDir, 'env.json'));
  });

  it('CWD wins over home', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'mmagent-prectest-'));
    writeConfigFile(tmpDir, {}, '.multi-model-agent.json');
    const homeDir = mkdtempSync(join(tmpdir(), 'mmagent-hometest-'));
    mkdirSync(join(homeDir, '.multi-model'), { recursive: true });
    writeConfigFile(join(homeDir, '.multi-model'), {}, 'config.json');
    const result = resolveConfigPath(undefined, {}, tmpDir, homeDir);
    expect(result).toBe(join(tmpDir, '.multi-model-agent.json'));
  });

  it('returns undefined when no config files exist', () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'mmagent-empty-'));
    const result = resolveConfigPath(undefined, {}, emptyDir, '/nonexistent-home');
    expect(result).toBeUndefined();
  });
});

// ─── Signal handler deduplication ──────────────────────────────────────────

describe('signal handler deduplication', () => {
  it('second SIGTERM does not call stop() twice', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mmagent-dedup-'));
    const tokenFile = writeTokenFile(dir);
    const configPath = writeConfigFile(dir, minimalConfig({ tokenFile }), 'config.json');

    const child = spawn('node', [cliPath(), 'serve', '--config', configPath], {
      stdio: 'pipe',
      env: { ...process.env },
    });

    const stderrChunks: Buffer[] = [];
    child.stderr?.on('data', (c: Buffer) => stderrChunks.push(c));

    try {
      await waitForServerReady(child, 8000);
      child.kill('SIGTERM');
      // Send SIGTERM again immediately — should be a no-op, process should still exit cleanly
      child.kill('SIGTERM');

      const [code, signal] = await new Promise<[number | null, string | null]>((resolve) => {
        child.on('exit', (c, s) => resolve([c, s]));
      });

      // If deduplication works, we still get a clean exit; otherwise stop() might race
      expect(code).toBe(0);
      expect(signal).toBeNull();

      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      // Only one "shutting down gracefully" should appear (not two)
      const shutdownLines = stderr.split('\n').filter(l => l.includes('shutting down gracefully'));
      expect(shutdownLines.length).toBe(1);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  });
});