import { describe, it, expect, vi } from 'vitest';
import type { MultiModelConfig, Provider, RunResult } from '@zhixuan92/multi-model-agent-core';

const providerRun = vi.fn<() => Promise<RunResult>>();
let activeProvider: Provider;

vi.mock('@zhixuan92/multi-model-agent-core/provider', () => ({
  createProvider: (slot: string) => {
    if (slot === 'standard') return activeProvider;
    return undefined;
  },
}));

vi.mock('@zhixuan92/multi-model-agent-core/escalation/policy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@zhixuan92/multi-model-agent-core/escalation/policy')>();
  return {
    ...actual,
    pickEscalation: vi.fn(() => ({
      impl: 'complex',
      reviewer: 'standard',
      isEscalated: false,
    })),
  };
});

import { runTasks } from '@zhixuan92/multi-model-agent-core/run-tasks';

const config: MultiModelConfig = {
  agents: {
    standard: { type: 'openai-compatible', model: 'std', baseUrl: 'https://ex.invalid/v1' },
    complex: { type: 'openai-compatible', model: 'cpx', baseUrl: 'https://ex2.invalid/v1' },
  },
  defaults: { tools: 'readonly', timeoutMs: 60_000, maxCostUSD: 1, sandboxPolicy: 'cwd-only' },
  server: {} as any,
};

describe('reviewed lifecycle fallback when both tiers are unavailable up front', () => {
  it('emits no fallback event, emits one fallback_unavailable event, and calls no provider', async () => {
    providerRun.mockClear();
    activeProvider = {
      name: 'standard',
      config: { type: 'openai-compatible', model: 'std', baseUrl: 'https://ex.invalid/v1' } as never,
      run: providerRun,
    };

    const events: string[] = [];
    const results = await runTasks(
      [{ prompt: 'go', agentType: 'standard', reviewPolicy: 'off' } as any],
      config,
      {
        batchId: 'batch-both-down',
        logger: {
          startup: () => {},
          requestStart: () => {},
          requestComplete: () => {},
          error: () => {},
          shutdown: () => {},
          expectedPath: () => undefined,
          sessionOpen: () => {},
          sessionClose: () => {},
          connectionRejected: () => {},
          requestRejected: () => {},
          projectCreated: () => {},
          projectEvicted: () => {},
          taskStarted: () => {},
          emit: (event) => { events.push(event.event); },
          batchCompleted: () => {},
          batchFailed: () => {},
          escalation: () => {},
          escalationUnavailable: () => {},
          fallback: () => { events.push('fallback'); },
          fallbackUnavailable: () => { events.push('fallback_unavailable'); },
        },
      },
    );

    expect(providerRun).not.toHaveBeenCalled();
    expect(events.filter((event) => event === 'fallback')).toHaveLength(0);
    expect(events.filter((event) => event === 'fallback_unavailable')).toHaveLength(1);
    expect(results[0].status).toBe('incomplete');
    expect(results[0].terminationReason).toBe('all_tiers_unavailable');
    expect(results[0].workerStatus).toBe('blocked');
  });
});
