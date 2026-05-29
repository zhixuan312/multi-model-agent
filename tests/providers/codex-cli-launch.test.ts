import { describe, it, expect } from 'bun:test';
import { buildCodexCliLaunch } from '../../packages/core/src/providers/codex-cli-launch.js';

describe('buildCodexCliLaunch (D7)', () => {
  it('A7.1: apiKey only, no apiKeyEnv → env.OPENAI_API_KEY is populated and -c flag uses OPENAI_API_KEY', () => {
    const result = buildCodexCliLaunch({
      cfg: { model: 'gpt-test', apiKey: 'sk-X', baseUrl: 'https://api.example.com/v1' },
      opts: { cwd: '/tmp' },
      outputFile: '/tmp/out.jsonl',
    });
    expect(result.env.OPENAI_API_KEY).toBe('sk-X');
    const providerFlag = result.args[result.args.findIndex(a => a === '-c' && result.args[result.args.indexOf(a)+1]?.startsWith('model_providers.mma-custom=')) + 1];
    expect(providerFlag).toContain('env_key="OPENAI_API_KEY"');
  });

  it('A7.2: apiKey + apiKeyEnv → env[apiKeyEnv] populated and -c flag uses that env name', () => {
    const result = buildCodexCliLaunch({
      cfg: { model: 'gpt-test', apiKey: 'sk-Y', apiKeyEnv: 'CUSTOM_KEY', baseUrl: 'https://api.example.com/v1' },
      opts: { cwd: '/tmp' },
      outputFile: '/tmp/out.jsonl',
    });
    expect(result.env.CUSTOM_KEY).toBe('sk-Y');
    const providerFlag = result.args[result.args.findIndex(a => a === '-c' && result.args[result.args.indexOf(a)+1]?.startsWith('model_providers.mma-custom=')) + 1];
    expect(providerFlag).toContain('env_key="CUSTOM_KEY"');
  });
});
