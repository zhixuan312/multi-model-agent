import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
  // No inline apiKey — the collectInlineApiKeyOffenders test asserts an exact
  // offender list, so this tier must never contribute to it.
  main: {
    type: 'codex' as const,
    model: 'test-model-main',
    baseUrl: 'https://test3.example.com/v1',
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
        main: {
          type: 'codex',
          model: 'claude-opus-4-7',
          baseUrl: 'https://api.claude.ai/v1',
        },
      },
    }));

    const config = await loadConfigFromFile(configPath);

    expect(config.agents!.standard!.type).toBe('codex');
    expect(config.agents!.standard!.model).toBe('deepseek-r1');
  });

  /**
   * The two read failures are different facts and must read differently.
   *
   * Every `fs.readFile` error used to become `Config file not found`, so a config that exists but
   * cannot be read — wrong owner after a sudo install, a directory where a file was expected —
   * sent the operator looking for a missing file that was sitting right there. Only ENOENT is
   * "not found".
   */
  it('names an unreadable config as unreadable, not as missing', async () => {
    // A directory reads as EISDIR: the path exists, and nothing about it is "not found".
    await expect(loadConfigFromFile(tmpDir)).rejects.toThrow(/could not be read \(EISDIR\)/);
    await expect(loadConfigFromFile(tmpDir)).rejects.not.toThrow(/not found/);
  });

  it('throws when explicit config path does not exist', async () => {
    await expect(loadConfigFromFile(path.join(tmpDir, 'nonexistent.json'))).rejects.toThrow(
      /Config file not found/,
    );
  });

  it('parses effort when present', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      agents: {
        standard: { type: 'claude', model: 'claude-opus-4-6', effort: 'high' },
        complex: minimalAgentConfig.complex,
        main: minimalAgentConfig.main,
      },
    }));

    const config = await loadConfigFromFile(configPath);
    expect(config.agents!.standard!.effort).toBe('high');
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
        main: minimalAgentConfig.main,
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
        main: minimalAgentConfig.main,
      },
    }));

    // process.stderr.write, not console.warn. The inline-apiKey warning lives in
    // `cli/serve.ts` and goes out through its `stderr(...)` helper — nothing in this codebase
    // warns via console.warn. Intercepting console.warn therefore watched a channel no warning
    // could ever arrive on: `warned` was false whether or not loadConfigFromFile warned, and
    // moving the warning INTO the loader (the regression this guards) left the test green.
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    try {
      await loadConfigFromFile(configPath);
    } finally {
      spy.mockRestore();
    }
    expect(written.join('')).toBe('');
  });
});
