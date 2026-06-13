import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfigFromFile } from '@zhixuan92/multi-model-agent-core/config/load';
import fs from 'fs';
import path from 'path';
import os from 'os';

const minimalAgentConfig = {
  standard: {
    type: 'codex' as const,
    model: 'test-model',
    baseUrl: 'https://test.example.com/v1',
  },
  complex: {
    type: 'codex' as const,
    model: 'test-model-complex',
    baseUrl: 'https://test2.example.com/v1',
  },
};

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
      agents: {
        standard: {
          type: 'codex',
          model: 'deepseek-r1',
          baseUrl: 'https://api.deepseek.com/v1',
          apiKeyEnv: 'DEEPSEEK_API_KEY',
        },
        complex: {
          type: 'codex',
          model: 'claude-opus-4-6',
          baseUrl: 'https://api.claude.ai/v1',
        },
      },
    }));

    const config = await loadConfigFromFile(configPath);

    expect(config.agents.standard.type).toBe('codex');
    expect(config.agents.standard.model).toBe('deepseek-r1');
    expect(config.defaults).toBeDefined();
  });

  it('throws when explicit config path does not exist', async () => {
    await expect(loadConfigFromFile(path.join(tmpDir, 'nonexistent.json'))).rejects.toThrow(
      /Config file not found/,
    );
  });

  it('merges user defaults with system defaults', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      agents: minimalAgentConfig,
      defaults: { mainModel: 'claude-opus-4-6' },
    }));

    const config = await loadConfigFromFile(configPath);

    expect(config.defaults.mainModel).toBe('claude-opus-4-6');
  });

  it('parses effort when present', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      agents: {
        standard: { type: 'claude', model: 'claude-opus-4-6', effort: 'high' },
        complex: minimalAgentConfig.complex,
      },
    }));

    const config = await loadConfigFromFile(configPath);
    expect(config.agents.standard.effort).toBe('high');
  });

  it('collectInlineApiKeyOffenders surfaces agents with inline apiKey', async () => {
    const { collectInlineApiKeyOffenders } = await import('@zhixuan92/multi-model-agent-core');
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      agents: {
        standard: {
          type: 'codex', model: 'test',
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'sk-inline-key',
        },
        complex: minimalAgentConfig.complex,
      },
    }));

    const config = await loadConfigFromFile(configPath);
    expect(collectInlineApiKeyOffenders(config)).toEqual(['standard']);
  });

  it('loadConfigFromFile stays silent on inline apiKey (warning is emitted by serve)', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      agents: {
        standard: {
          type: 'codex', model: 'test',
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'sk-inline-key',
        },
        complex: minimalAgentConfig.complex,
      },
    }));

    let warned = false;
    const originalWarn = console.warn;
    console.warn = () => { warned = true; };
    try {
      await loadConfigFromFile(configPath);
    } finally {
      console.warn = originalWarn;
    }
    expect(warned).toBe(false);
  });
});
