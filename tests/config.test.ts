import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/config.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('loadConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mma-config-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads a valid config file', () => {
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

    const config = loadConfig(configPath);

    expect(config.providers.deepseek.type).toBe('openai-compatible');
    expect(config.providers.deepseek.model).toBe('deepseek-r1');
    expect(config.defaults.maxTurns).toBe(200);
    expect(config.defaults.timeoutMs).toBe(600000);
    expect(config.defaults.tools).toBe('full');
  });

  it('applies defaults when only providers given', () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      providers: {
        codex: { type: 'codex', model: 'gpt-5.4' },
      },
    }));

    const config = loadConfig(configPath);

    expect(config.defaults.maxTurns).toBe(200);
    expect(config.defaults.tools).toBe('full');
    expect(config.providers.codex.type).toBe('codex');
  });

  it('throws when explicit config path does not exist', () => {
    expect(() => loadConfig(path.join(tmpDir, 'nonexistent.json'))).toThrow(
      /Config file not found/,
    );
  });

  it('validates provider type enum', () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      providers: {
        bad: { type: 'invalid-type', model: 'whatever' },
      },
    }));

    expect(() => loadConfig(configPath)).toThrow();
  });

  it('throws when MULTI_MODEL_CONFIG env var points to nonexistent file', () => {
    const prev = process.env.MULTI_MODEL_CONFIG;
    try {
      process.env.MULTI_MODEL_CONFIG = path.join(tmpDir, 'ghost.json');
      expect(() => loadConfig()).toThrow(/Config file not found \(MULTI_MODEL_CONFIG\)/);
    } finally {
      if (prev === undefined) delete process.env.MULTI_MODEL_CONFIG;
      else process.env.MULTI_MODEL_CONFIG = prev;
    }
  });

  it('rejects maxTurns <= 0', () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      providers: {},
      defaults: { maxTurns: 0 },
    }));
    expect(() => loadConfig(configPath)).toThrow();
  });

  it('rejects negative timeoutMs', () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      providers: {},
      defaults: { timeoutMs: -1 },
    }));
    expect(() => loadConfig(configPath)).toThrow();
  });

  it('rejects non-integer maxTurns', () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      providers: {},
      defaults: { maxTurns: 1.5 },
    }));
    expect(() => loadConfig(configPath)).toThrow();
  });

  it('rejects provider-level maxTurns <= 0', () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      providers: {
        bad: { type: 'openai-compatible', model: 'test', maxTurns: -5 },
      },
    }));
    expect(() => loadConfig(configPath)).toThrow();
  });

  it('merges user defaults with system defaults', () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      providers: {},
      defaults: { maxTurns: 50 },
    }));

    const config = loadConfig(configPath);

    expect(config.defaults.maxTurns).toBe(50);
    expect(config.defaults.timeoutMs).toBe(600000);
    expect(config.defaults.tools).toBe('full');
  });
});
