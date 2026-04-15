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
      const content = fs.readFileSync(p, 'utf-8');
      return JSON.parse(content);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prefers --config argument over MULTI_MODEL_CONFIG env var', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mma-test-'));
    const argConfigPath = path.join(tmpDir, 'arg-config.json');
    fs.writeFileSync(
      argConfigPath,
      JSON.stringify({
        agents: {
          standard: { type: 'openai-compatible', model: 'x', baseUrl: 'https://x.com' },
          complex: { type: 'claude', model: 'claude-sonnet-4-6' },
        },
        defaults: { timeoutMs: 1_800_000, tools: 'full' },
      }),
    );

    vi.spyOn(process, 'argv', 'get').mockReturnValue([
      'node',
      'cli.js',
      'serve',
      '--config',
      argConfigPath,
    ]);
    vi.stubEnv('MULTI_MODEL_CONFIG', '/env/path-that-should-not-be-read.json');

    const { discoverConfig } = await import('../packages/mcp/src/cli.js');
    const config = await discoverConfig();

    expect(config.agents.standard).toBeDefined();

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('falls back to MULTI_MODEL_CONFIG env var when no --config', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mma-test-'));
    const envConfigPath = path.join(tmpDir, 'env-config.json');
    fs.writeFileSync(
      envConfigPath,
      JSON.stringify({
        agents: {
          standard: { type: 'claude', model: 'claude-sonnet-4-6' },
          complex: { type: 'claude', model: 'claude-opus-4-6' },
        },
        defaults: { timeoutMs: 1_800_000, tools: 'full' },
      }),
    );

    vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'cli.js', 'serve']);
    vi.stubEnv('MULTI_MODEL_CONFIG', envConfigPath);

    const { discoverConfig } = await import('../packages/mcp/src/cli.js');
    const config = await discoverConfig();

    expect(config.agents.standard).toBeDefined();

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
        agents: {
          standard: { type: 'codex', model: 'gpt-5-codex' },
          complex: { type: 'claude', model: 'claude-opus-4-6' },
        },
        defaults: { timeoutMs: 1_800_000, tools: 'full' },
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

    expect(config.agents.standard).toBeDefined();

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty config when no file exists at any path', async () => {
    vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'cli.js', 'serve']);
    vi.stubEnv('MULTI_MODEL_CONFIG', '');
    vi.spyOn(os, 'homedir').mockReturnValue('/nonexistent-home');
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    mockLoadConfigFromFile.mockRejectedValue(new Error('ENOENT'));

    const { discoverConfig } = await import('../packages/mcp/src/cli.js');
    const config = await discoverConfig();

    expect(config.agents).toBeDefined();
    expect(config.agents.standard).toBeDefined();
    expect(config.agents.complex).toBeDefined();
    expect(config.defaults.timeoutMs).toBe(1_800_000);
    expect(config.defaults.tools).toBe('full');
  });
});
