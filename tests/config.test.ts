import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { loadConfigFromFile } from '@zhixuan92/multi-model-agent-core/config/load';
import { parseConfig } from '@zhixuan92/multi-model-agent-core/config/schema';
import type { MultiModelConfig } from '@zhixuan92/multi-model-agent-core';
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
    expect(config.defaults.timeoutMs).toBe(3_600_000);
    expect(config.defaults.tools).toBe('full');
  });

  it('throws when explicit config path does not exist', async () => {
    await expect(loadConfigFromFile(path.join(tmpDir, 'nonexistent.json'))).rejects.toThrow(
      /Config file not found/,
    );
  });

  it('validates agent type enum', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      agents: {
        standard: { type: 'invalid-type', model: 'whatever' } as any,
        complex: minimalAgentConfig.complex,
      },
    }));

    await expect(loadConfigFromFile(configPath)).rejects.toThrow();
  });

  it('rejects negative timeoutMs', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      agents: minimalAgentConfig,
      defaults: { timeoutMs: -1 },
    }));
    await expect(loadConfigFromFile(configPath)).rejects.toThrow();
  });

  it('merges user defaults with system defaults', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      agents: minimalAgentConfig,
      defaults: { timeoutMs: 300_000 },
    }));

    const config = await loadConfigFromFile(configPath);

    expect(config.defaults.timeoutMs).toBe(300_000);
    expect(config.defaults.tools).toBe('full');
  });

  it('parses effort when present', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      agents: {
        standard: {
          type: 'claude',
          model: 'claude-opus-4-6',
          effort: 'high',
        },
        complex: minimalAgentConfig.complex,
      },
    }));

    const config = await loadConfigFromFile(configPath);

    expect(config.agents.standard.effort).toBe('high');
  });

  it('rejects invalid effort values', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      agents: {
        standard: {
          type: 'claude',
          model: 'claude-opus-4-6',
          effort: 'ultra',
        },
        complex: minimalAgentConfig.complex,
      },
    }));

    await expect(loadConfigFromFile(configPath)).rejects.toThrow();
  });

  it('accepts effort=none as a valid disable signal', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      agents: {
        standard: {
          type: 'claude',
          model: 'claude-opus-4-6',
          effort: 'none',
        },
        complex: minimalAgentConfig.complex,
      },
    }));

    const config = await loadConfigFromFile(configPath);

    expect(config.agents.standard.effort).toBe('none');
  });

  it('accepts codex without baseUrl (defaults to ChatGPT subscription via codex CLI)', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      agents: {
        standard: { type: 'codex', model: 'gpt-5.5' },
        complex: minimalAgentConfig.complex,
      },
    }));
    await expect(loadConfigFromFile(configPath)).resolves.toBeDefined();
  });

  it('collectInlineApiKeyOffenders surfaces agents with inline apiKey', async () => {
    const { collectInlineApiKeyOffenders } = await import('@zhixuan92/multi-model-agent-core');
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      agents: {
        standard: {
          type: 'codex',
          model: 'test',
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
          type: 'codex',
          model: 'test',
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

describe('1.0.0 agents config schema', () => {
  it('accepts a minimal two-slot config', () => {
    const raw = {
      agents: {
        standard: { type: 'codex', model: 'gpt-5-codex' },
        complex: { type: 'claude', model: 'claude-opus-4-6' },
      },
    };
    const config = parseConfig(raw);
    expect(config.agents.standard.type).toBe('codex');
    expect(config.agents.complex.type).toBe('claude');
  });

  it('accepts codex with baseUrl + apiKeyEnv (OpenAI-compatible backend)', () => {
    const raw = {
      agents: {
        standard: {
          type: 'codex',
          model: 'deepseek-r1',
          baseUrl: 'https://api.deepseek.com/v1',
          apiKeyEnv: 'DEEPSEEK_API_KEY',
        },
        complex: { type: 'claude', model: 'claude-opus-4-6' },
      },
    };
    expect(() => parseConfig(raw)).not.toThrow();
  });

  it('accepts codex without baseUrl (defaults to ChatGPT subscription)', () => {
    const raw = {
      agents: {
        standard: { type: 'codex', model: 'gpt-5.5' },
        complex: { type: 'claude', model: 'claude-opus-4-6' },
      },
    };
    expect(() => parseConfig(raw)).not.toThrow();
  });

  it('accepts claude with baseUrl (Anthropic-compatible backend)', () => {
    const raw = {
      agents: {
        standard: { type: 'codex', model: 'gpt-5.5' },
        complex: {
          type: 'claude',
          model: 'claude-opus-4-6',
          baseUrl: 'https://api.anthropic-proxy.example.com',
          apiKeyEnv: 'ANTHROPIC_PROXY_KEY',
        },
      },
    };
    expect(() => parseConfig(raw)).not.toThrow();
  });

  it('accepts codex with inline apiKey (warned about via collectInlineApiKeyOffenders, not rejected)', () => {
    const raw = {
      agents: {
        standard: {
          type: 'codex',
          model: 'gpt-5.5',
          apiKey: 'sk-inline',
        },
        complex: { type: 'claude', model: 'claude-opus-4-6' },
      },
    };
    expect(() => parseConfig(raw)).not.toThrow();
  });

  it('rejects config missing the complex slot', () => {
    const raw = {
      agents: {
        standard: { type: 'codex', model: 'gpt-5-codex' },
      },
    };
    expect(() => parseConfig(raw)).toThrow();
  });

});

describe('server config block', () => {
  it('defaults to sensible values when omitted', () => {
    const cfg = parseConfig({ agents: { standard: { type: 'claude', model: 'x' }, complex: { type: 'claude', model: 'x' } } });
    expect(cfg.server).toBeDefined();
    expect(cfg.server.bind).toBe('127.0.0.1');
    expect(cfg.server.port).toBe(7337);
    expect(cfg.server.auth.tokenFile).toBe('~/.multi-model/auth-token');
    expect(cfg.server.limits.projectCap).toBe(200);
    expect(cfg.server.limits.shutdownDrainMs).toBe(30_000);
    expect(cfg.server.limits.maxBodyBytes).toBe(262144);
    expect(cfg.defaults.stallTimeoutMs).toBe(1_200_000);
  });

  it('accepts server block with overrides', () => {
    const cfg = parseConfig({
      agents: { standard: { type: 'claude', model: 'x' }, complex: { type: 'claude', model: 'x' } },
      server: { port: 9999 },
    });
    expect(cfg.server.port).toBe(9999);
    expect(cfg.server.bind).toBe('127.0.0.1'); // default preserved
  });

  it('rejects negative port', () => {
    expect(() => parseConfig({
      agents: { standard: { type: 'claude', model: 'x' }, complex: { type: 'claude', model: 'x' } },
      server: { port: -1 },
    })).toThrow();
  });

  it('rejects unknown top-level keys (e.g. legacy transport)', () => {
    expect(() => parseConfig({
      agents: { standard: { type: 'claude', model: 'x' }, complex: { type: 'claude', model: 'x' } },
      transport: { mode: 'http' },
    })).toThrow();
  });
});
