import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfigFromFile } from '@zhixuan92/multi-model-agent-core/config/load';
import type { MultiModelConfig } from '@zhixuan92/multi-model-agent-core';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('loadConfigFromFile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mma-config-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads a valid config file', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      providers: {
        deepseek: {
          type: 'openai-compatible',
          model: 'deepseek-r1',
          baseUrl: 'https://api.deepseek.com/v1',
          apiKeyEnv: 'DEEPSEEK_API_KEY',
        },
      },
    }));

    const config = await loadConfigFromFile(configPath);

    expect(config.providers.deepseek.type).toBe('openai-compatible');
    expect(config.providers.deepseek.model).toBe('deepseek-r1');
    expect(config.defaults.maxTurns).toBe(200);
    expect(config.defaults.timeoutMs).toBe(600000);
    expect(config.defaults.tools).toBe('full');
  });

  it('applies defaults when only providers given', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      providers: {
        codex: { type: 'codex', model: 'gpt-5.4' },
      },
    }));

    const config = await loadConfigFromFile(configPath);

    expect(config.defaults.maxTurns).toBe(200);
    expect(config.defaults.tools).toBe('full');
    expect(config.providers.codex.type).toBe('codex');
  });

  it('throws when explicit config path does not exist', async () => {
    await expect(loadConfigFromFile(path.join(tmpDir, 'nonexistent.json'))).rejects.toThrow(
      /Config file not found/,
    );
  });

  it('validates provider type enum', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      providers: {
        bad: { type: 'invalid-type', model: 'whatever' },
      },
    }));

    await expect(loadConfigFromFile(configPath)).rejects.toThrow();
  });

  it('rejects maxTurns <= 0', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      providers: {},
      defaults: { maxTurns: 0 },
    }));
    await expect(loadConfigFromFile(configPath)).rejects.toThrow();
  });

  it('rejects negative timeoutMs', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      providers: {},
      defaults: { timeoutMs: -1 },
    }));
    await expect(loadConfigFromFile(configPath)).rejects.toThrow();
  });

  it('rejects non-integer maxTurns', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      providers: {},
      defaults: { maxTurns: 1.5 },
    }));
    await expect(loadConfigFromFile(configPath)).rejects.toThrow();
  });

  it('rejects provider-level maxTurns <= 0', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      providers: {
        bad: { type: 'openai-compatible', model: 'test', maxTurns: -5 },
      },
    }));
    await expect(loadConfigFromFile(configPath)).rejects.toThrow();
  });

  it('merges user defaults with system defaults', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      providers: {},
      defaults: { maxTurns: 50 },
    }));

    const config = await loadConfigFromFile(configPath);

    expect(config.defaults.maxTurns).toBe(50);
    expect(config.defaults.timeoutMs).toBe(600000);
    expect(config.defaults.tools).toBe('full');
  });

  it('parses costTier when present', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      providers: {
        minimax: {
          type: 'openai-compatible',
          model: 'MiniMax-M2',
          baseUrl: 'https://api.example.com/v1',
          costTier: 'free',
        },
      },
    }));

    const config = await loadConfigFromFile(configPath);

    expect(config.providers.minimax.costTier).toBe('free');
  });

  it('accepts config without costTier (optional field)', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      providers: {
        gpt: {
          type: 'openai-compatible',
          model: 'gpt-5',
          baseUrl: 'https://api.example.com/v1',
        },
      },
    }));

    const config = await loadConfigFromFile(configPath);

    expect(config.providers.gpt.costTier).toBeUndefined();
  });

  it('rejects invalid costTier values', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      providers: {
        bad: {
          type: 'openai-compatible',
          model: 'x',
          baseUrl: 'https://api.example.com/v1',
          costTier: 'gigantic',
        },
      },
    }));

    await expect(loadConfigFromFile(configPath)).rejects.toThrow();
  });

  it('rejects openai-compatible without baseUrl', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      providers: {
        bad: { type: 'openai-compatible', model: 'test' },
      },
    }));
    await expect(loadConfigFromFile(configPath)).rejects.toThrow(/baseUrl/);
  });

  it('parses a valid effort enum value', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      providers: {
        claude: {
          type: 'claude',
          model: 'claude-opus-4-6',
          effort: 'high',
        },
      },
    }));

    const config = await loadConfigFromFile(configPath);

    expect(config.providers.claude.effort).toBe('high');
  });

  it('rejects invalid effort values', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      providers: {
        bad: {
          type: 'claude',
          model: 'claude-opus-4-6',
          effort: 'ultra',
        },
      },
    }));

    await expect(loadConfigFromFile(configPath)).rejects.toThrow();
  });

  it('accepts effort=none as a valid disable signal', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      providers: {
        claude: {
          type: 'claude',
          model: 'claude-opus-4-6',
          effort: 'none',
        },
      },
    }));

    const config = await loadConfigFromFile(configPath);

    expect(config.providers.claude.effort).toBe('none');
  });
});