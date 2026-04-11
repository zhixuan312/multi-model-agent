import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';

const mockLoadConfigFromFile = vi.fn();

vi.mock('@zhixuan92/multi-model-agent-core/config/load', () => ({
  loadConfigFromFile: mockLoadConfigFromFile,
}));

describe('discoverConfig precedence', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockLoadConfigFromFile.mockReset();
    mockLoadConfigFromFile.mockImplementation((p: string) => {
      // When a path is given, parse the JSON content from it
      // (used by tests that provide real file content via readFileSync mocks)
      const content = fs.readFileSync(p, 'utf-8');
      return JSON.parse(content);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prefers --config argument over MULTI_MODEL_CONFIG env var', async () => {
    // create a temp file for the --config path so loadConfigFromFile can read it
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mma-test-'));
    const argConfigPath = path.join(tmpDir, 'arg-config.json');
    fs.writeFileSync(
      argConfigPath,
      JSON.stringify({
        providers: {
          a: { type: 'openai-compatible', model: 'x', baseUrl: 'https://x.com' },
        },
        defaults: { maxTurns: 200, timeoutMs: 600_000, tools: 'full' },
      }),
    );

    vi.spyOn(process, 'argv', 'get').mockReturnValue([
      'node',
      'cli.js',
      'serve',
      '--config',
      argConfigPath,
    ]);
    // Env var is set to a path that would error if used — proves --config wins.
    vi.stubEnv('MULTI_MODEL_CONFIG', '/env/path-that-should-not-be-read.json');

    const { discoverConfig } = await import('../packages/mcp/src/cli.js');
    const config = await discoverConfig();

    expect(config.providers.a).toBeDefined();

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('falls back to MULTI_MODEL_CONFIG env var when no --config', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mma-test-'));
    const envConfigPath = path.join(tmpDir, 'env-config.json');
    fs.writeFileSync(
      envConfigPath,
      JSON.stringify({
        providers: {
          b: { type: 'claude', model: 'claude-sonnet-4-6' },
        },
        defaults: { maxTurns: 200, timeoutMs: 600_000, tools: 'full' },
      }),
    );

    vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'cli.js', 'serve']);
    vi.stubEnv('MULTI_MODEL_CONFIG', envConfigPath);

    const { discoverConfig } = await import('../packages/mcp/src/cli.js');
    const config = await discoverConfig();

    expect(config.providers.b).toBeDefined();

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('falls back to ~/.multi-model/config.json when no env var or --config', async () => {
    vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'cli.js', 'serve']);
    vi.stubEnv('MULTI_MODEL_CONFIG', '');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mma-home-'));
    const homeConfigPath = path.join(tmpDir, '.multi-model', 'config.json');
    fs.mkdirSync(path.dirname(homeConfigPath), { recursive: true });
    fs.writeFileSync(
      homeConfigPath,
      JSON.stringify({
        providers: {
          c: { type: 'codex', model: 'gpt-5-codex' },
        },
        defaults: { maxTurns: 200, timeoutMs: 600_000, tools: 'full' },
      }),
    );

    vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);

    mockLoadConfigFromFile.mockImplementation((p: string) => {
      if (p === homeConfigPath) {
        return JSON.parse(fs.readFileSync(p, 'utf-8'));
      }
      throw new Error(`Unexpected path: ${p}`);
    });

    const { discoverConfig } = await import('../packages/mcp/src/cli.js');
    const config = await discoverConfig();

    expect(config.providers.c).toBeDefined();

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty config when no file exists at any path', async () => {
    vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'cli.js', 'serve']);
    vi.stubEnv('MULTI_MODEL_CONFIG', '');
    vi.spyOn(os, 'homedir').mockReturnValue('/nonexistent-home');
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    // Make loadConfigFromFile throw so the fallback to parseConfig({}) is exercised
    mockLoadConfigFromFile.mockRejectedValue(new Error('ENOENT'));

    const { discoverConfig } = await import('../packages/mcp/src/cli.js');
    const config = await discoverConfig();

    expect(config.providers).toEqual({});
    expect(config.defaults.maxTurns).toBe(200);
    expect(config.defaults.timeoutMs).toBe(600_000);
    expect(config.defaults.tools).toBe('full');
  });
});
