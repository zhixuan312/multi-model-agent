import { describe, it, expect } from 'vitest';
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

  const sandboxOf = (args: string[]): string | undefined => args[args.indexOf('-s') + 1];

  it('never disables the sandbox (no --dangerously-bypass-approvals-and-sandbox; approvals suppressed via --ask-for-approval never)', () => {
    const result = buildCodexCliLaunch({
      cfg: { model: 'gpt-test' },
      opts: { cwd: '/tmp', sandboxPolicy: 'cwd-only' },
      outputFile: '/tmp/out.jsonl',
    });
    expect(result.args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    // global --ask-for-approval never precedes the exec subcommand
    expect(result.args.slice(0, 3)).toEqual(['--ask-for-approval', 'never', 'exec']);
  });

  it('maps sandboxPolicy read-only → -s read-only', () => {
    const result = buildCodexCliLaunch({
      cfg: { model: 'gpt-test' },
      opts: { cwd: '/tmp', sandboxPolicy: 'read-only' },
      outputFile: '/tmp/out.jsonl',
    });
    expect(sandboxOf(result.args)).toBe('read-only');
  });

  it('maps sandboxPolicy cwd-only (and default) → -s workspace-write', () => {
    const cwdOnly = buildCodexCliLaunch({
      cfg: { model: 'gpt-test' },
      opts: { cwd: '/tmp', sandboxPolicy: 'cwd-only' },
      outputFile: '/tmp/out.jsonl',
    });
    expect(sandboxOf(cwdOnly.args)).toBe('workspace-write');
    const noPolicy = buildCodexCliLaunch({
      cfg: { model: 'gpt-test' },
      opts: { cwd: '/tmp' },
      outputFile: '/tmp/out.jsonl',
    });
    expect(sandboxOf(noPolicy.args)).toBe('workspace-write');
  });
});
