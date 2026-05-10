import { describe, it, expect, vi } from 'vitest';
import { RunnerShell } from '../../packages/core/src/providers/runner-shell.js';
import type { RunnerAdapter, AdapterTurnResult, AdapterTurnInput } from '../../packages/core/src/providers/runner-adapter.js';

describe('RunnerShell.prime()', () => {
  it('sends one minimal turn with cache_control on the system prompt; cacheControlSent reflects what we sent, not what upstream reported', async () => {
    const calls: AdapterTurnInput[] = [];
    const adapter: RunnerAdapter = {
      providerType: 'claude',
      async turn(input) {
        calls.push(input);
        return {
          assistantText: 'ready',
          toolCalls: [],
          finishReason: 'stop',
          usage: { inputTokens: 100, outputTokens: 1, cachedReadTokens: 0, cachedNonReadTokens: 100 },
        } satisfies AdapterTurnResult;
      },
    };
    const shell = new RunnerShell(adapter, 'test-model');
    const result = await shell.prime('SYSTEM PREFIX', { cwd: '/tmp', cacheControl: { type: 'ephemeral' } });

    expect(calls).toHaveLength(1);
    expect(calls[0].systemPrompt).toBe('SYSTEM PREFIX');
    expect(calls[0].userMessage).toBe('ready');
    expect(calls[0].cacheControl).toEqual({ type: 'ephemeral' });
    expect(calls[0].toolDefinitions).toEqual([]);
    expect(result.cacheControlSent).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.usage.inputTokens).toBe(100);
  });

  it('cacheControlSent=false when caller did not pass cacheControl (codex / providers without cache support)', async () => {
    const adapter: RunnerAdapter = {
      providerType: 'codex',
      async turn() {
        return {
          assistantText: 'ready',
          toolCalls: [],
          finishReason: 'stop',
          usage: { inputTokens: 100, outputTokens: 1, cachedReadTokens: 0, cachedNonReadTokens: 0 },
        } satisfies AdapterTurnResult;
      },
    };
    const shell = new RunnerShell(adapter);
    const result = await shell.prime('SYSTEM PREFIX', { cwd: '/tmp' });
    expect(result.cacheControlSent).toBe(false);
    expect(result.capHit).toBe(false);
  });

  it('warmer 10-minute hard cap aborts, returns capHit=true, dispatcher can proceed without cache', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'queueMicrotask'] });
    try {
      const events: any[] = [];
      const bus = { on: vi.fn(), emit: (e: any) => events.push(e) } as any;
      const adapter: RunnerAdapter = {
        providerType: 'claude',
        async turn(input) {
          // Hang until aborted.
          await new Promise<void>((resolve) => {
            input.abortSignal!.addEventListener('abort', () => resolve(), { once: true });
          });
          return {
            assistantText: '',
            toolCalls: [],
            finishReason: 'error',
            usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 },
            errorCode: 'aborted',
          };
        },
      };
      const shell = new RunnerShell(adapter, 'test');
      const primed = shell.prime('SYSTEM PREFIX', { cwd: '/tmp', cacheControl: { type: 'ephemeral' }, bus });
      await vi.advanceTimersByTimeAsync(11 * 60 * 1000);
      const result = await primed;
      expect(result.capHit).toBe(true);
      expect(result.cacheControlSent).toBe(false);
      expect(events.find(e => e.event === 'criteria_fanout_warm_soft_warning')).toBeDefined();
      expect(events.find(e => e.event === 'criteria_fanout_warm_cap_hit')).toBeDefined();
      expect(events.find(e => e.event === 'criteria_fanout_warm_complete' && e.capHit === true)).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
