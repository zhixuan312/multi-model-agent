import { describe, it, expect, vi } from 'vitest';
import { resolveEffort } from '../../packages/core/src/providers/effort.js';
import { DEFAULT_EFFORT } from '../../packages/core/src/types/task-spec.js';
import { buildCodexCliLaunch } from '../../packages/core/src/providers/codex-cli-launch.js';
import { makeClaudeProvider } from '../../packages/core/src/providers/claude.js';
import { createProvider } from '../../packages/core/src/providers/provider-factory.js';
import type { MultiModelConfig } from '../../packages/core/src/types.js';

// Captures the options object handed to the SDK so the claude path can be
// asserted without a live query.
const queryCalls: Array<Record<string, unknown>> = [];
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn((arg: { options: Record<string, unknown> }) => {
    queryCalls.push(arg.options);
    return {
      [Symbol.asyncIterator]() {
        return { async next(): Promise<IteratorResult<unknown>> { return { value: undefined, done: true }; } };
      },
      close() { /* no-op */ },
    };
  }),
}));

const sessionOpts = {
  cwd: '/tmp',
  wallClockDeadline: Date.now() + 5_000,
  abortSignal: new AbortController().signal,
  taskId: 'T',
  taskIndex: 0,
} as never;

const effortFlagOf = (args: string[]): string | undefined => {
  const i = args.findIndex((a, n) => a === '-c' && args[n + 1]?.startsWith('model_reasoning_effort='));
  return i === -1 ? undefined : args[i + 1];
};

describe('resolveEffort', () => {
  it('defaults to high when the config sets no effort', () => {
    expect(DEFAULT_EFFORT).toBe('high');
    expect(resolveEffort('claude-sonnet-5')).toBe('high');
    expect(resolveEffort('gpt-5.6-terra')).toBe('high');
  });

  it('honours a configured override, including the levels above high', () => {
    expect(resolveEffort('claude-opus-5', 'low')).toBe('low');
    expect(resolveEffort('claude-opus-5', 'xhigh')).toBe('xhigh');
    expect(resolveEffort('claude-opus-5', 'max')).toBe('max');
    expect(resolveEffort('gpt-5.6-terra', 'none')).toBe('none');
  });

  it('returns undefined for models with no effort knob — configured or not', () => {
    // `type` is a wire protocol, not a vendor: these run behind the claude /
    // codex protocols but reject a reasoning-effort parameter.
    expect(resolveEffort('glm-5')).toBeUndefined();
    expect(resolveEffort('deepseek-v4-pro', 'high')).toBeUndefined();
    expect(resolveEffort('kimi-k3')).toBeUndefined();
    // Unrecognised ids fall back to the registry default profile.
    expect(resolveEffort('some-unknown-model-9000')).toBeUndefined();
  });
});

describe('codex runner — model_reasoning_effort', () => {
  it('emits the resolved level as a -c override', () => {
    const launch = buildCodexCliLaunch({
      cfg: { model: 'gpt-5.6-terra', effort: 'high' },
      opts: { cwd: '/tmp' },
      outputFile: '/tmp/out.jsonl',
    });
    expect(effortFlagOf(launch.args)).toBe('model_reasoning_effort="high"');
  });

  it('emits nothing when the model has no effort knob', () => {
    const launch = buildCodexCliLaunch({
      cfg: { model: 'glm-5' },
      opts: { cwd: '/tmp' },
      outputFile: '/tmp/out.jsonl',
    });
    expect(effortFlagOf(launch.args)).toBeUndefined();
  });

  it('applies on resume turns too — -c overrides are per-invocation', () => {
    const launch = buildCodexCliLaunch({
      cfg: { model: 'gpt-5.6-terra', effort: 'xhigh' },
      opts: { cwd: '/tmp' },
      outputFile: '/tmp/out.jsonl',
      resumeSessionId: 'thread-1',
    });
    expect(effortFlagOf(launch.args)).toBe('model_reasoning_effort="xhigh"');
  });
});

describe('claude runner — effort option', () => {
  it('sends the default high when the config sets no effort', async () => {
    queryCalls.length = 0;
    const provider = makeClaudeProvider({ type: 'claude', model: 'claude-sonnet-5' });
    await provider.openSession(sessionOpts).send('hi');
    expect(queryCalls.at(-1)?.effort).toBe('high');
  });

  it('sends a configured level verbatim', async () => {
    queryCalls.length = 0;
    const provider = makeClaudeProvider({ type: 'claude', model: 'claude-opus-5', effort: 'max' });
    await provider.openSession(sessionOpts).send('hi');
    expect(queryCalls.at(-1)?.effort).toBe('max');
  });

  it('maps effort=none onto thinking:disabled — the SDK has no none level', async () => {
    queryCalls.length = 0;
    const provider = makeClaudeProvider({ type: 'claude', model: 'claude-opus-5', effort: 'none' });
    await provider.openSession(sessionOpts).send('hi');
    expect(queryCalls.at(-1)?.effort).toBeUndefined();
    expect(queryCalls.at(-1)?.thinking).toEqual({ type: 'disabled' });
  });

  it('sends no effort option for a model without an effort knob', async () => {
    queryCalls.length = 0;
    const provider = makeClaudeProvider({ type: 'claude', model: 'glm-5', baseUrl: 'https://example.invalid' });
    await provider.openSession(sessionOpts).send('hi');
    expect(queryCalls.at(-1)?.effort).toBeUndefined();
    expect(queryCalls.at(-1)?.thinking).toBeUndefined();
  });
});

describe('provider factory — effort forwarding', () => {
  const configWith = (effort?: string): MultiModelConfig => ({
    agents: {
      standard: { type: 'claude', model: 'claude-sonnet-5', ...(effort && { effort }) },
      complex: { type: 'codex', model: 'gpt-5.6-terra', ...(effort && { effort }) },
      main: { type: 'claude', model: 'claude-opus-5' },
    },
  } as never);

  it('carries the per-tier override into the provider config', () => {
    expect(createProvider('standard', configWith('low')).config.effort).toBe('low');
    expect(createProvider('complex', configWith('low')).config.effort).toBe('low');
  });

  it('leaves the provider config effort unset when the tier does not override it', () => {
    expect(createProvider('standard', configWith()).config.effort).toBeUndefined();
  });
});
