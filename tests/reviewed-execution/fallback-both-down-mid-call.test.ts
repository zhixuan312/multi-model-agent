import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MultiModelConfig, Provider, RunResult } from '@zhixuan92/multi-model-agent-core';
import type { DiagnosticLogger } from '@zhixuan92/multi-model-agent-core/diagnostics/disconnect-log';

const providerCalls: string[] = [];
let originalSetTimeout: typeof globalThis.setTimeout;

function apiErrorResult(provider: string): RunResult {
  return {
    output: '',
    status: 'api_error',
    usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1, costUSD: 0 },
    turns: 1,
    filesRead: [],
    filesWritten: [],
    toolCalls: [],
    outputIsDiagnostic: true,
    escalationLog: [],
    error: `${provider} api down`,
  };
}

function failProvider(name: 'standard' | 'complex'): Provider {
  const attemptsByProvider = new Map<string, number>();
  return {
    name,
    config: { type: 'openai-compatible', model: `${name}-model`, baseUrl: 'https://ex.invalid/v1' },
    async run(): Promise<RunResult> {
      const attempts = attemptsByProvider.get(name) ?? 0;
      attemptsByProvider.set(name, attempts + 1);
      if (attempts === 0) providerCalls.push(name);
      return apiErrorResult(name);
    },
  };
}

vi.mock('@zhixuan92/multi-model-agent-core/provider', () => ({
  createProvider: (slot: 'standard' | 'complex') => failProvider(slot),
}));

import { runTasks } from '@zhixuan92/multi-model-agent-core/run-tasks';

beforeEach(() => {
  originalSetTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: TimerHandler, _timeout?: number, ...args: unknown[]) =>
    originalSetTimeout(handler, 0, ...args)) as typeof setTimeout);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const config: MultiModelConfig = {
  agents: {
    standard: { type: 'openai-compatible', model: 'std', baseUrl: 'https://ex.invalid/v1' },
    complex: { type: 'openai-compatible', model: 'cpx', baseUrl: 'https://ex2.invalid/v1' },
  },
  defaults: { timeoutMs: 600_000, maxCostUSD: 10, tools: 'full', sandboxPolicy: 'none' },
  server: {
    bind: '127.0.0.1',
    port: 0,
    auth: { tokenFile: '.token' },
    limits: { maxBodyBytes: 1, batchTtlMs: 1, idleProjectTimeoutMs: 1, clarificationTimeoutMs: 1, projectCap: 1, maxBatchCacheSize: 1, maxContextBlockBytes: 1, maxContextBlocksPerProject: 1, shutdownDrainMs: 1 },
    autoUpdateSkills: false,
  },
};

describe('reviewed lifecycle fallback when both providers go down mid-call', () => {
  it('emits fallback + fallback_unavailable and records one bothUnavailable override', async () => {
    providerCalls.length = 0;
    const fallback = vi.fn();
    const fallbackUnavailable = vi.fn();
    const logger = {
      fallback,
      fallbackUnavailable,
      emit: vi.fn(),
      startup: vi.fn(),
      requestStart: vi.fn(),
      requestComplete: vi.fn(),
      error: vi.fn(),
      shutdown: vi.fn(),
      expectedPath: vi.fn(),
      sessionOpen: vi.fn(),
      sessionClose: vi.fn(),
      connectionRejected: vi.fn(),
      requestRejected: vi.fn(),
      projectCreated: vi.fn(),
      projectEvicted: vi.fn(),
      taskStarted: vi.fn(),
      batchCompleted: vi.fn(),
      batchFailed: vi.fn(),
      escalation: vi.fn(),
      escalationUnavailable: vi.fn(),
    } as unknown as DiagnosticLogger;

    const [result] = await runTasks(
      [{ prompt: 'implement something', agentType: 'standard', reviewPolicy: 'off', skipCompletionHeuristic: true }],
      config,
      { batchId: 'batch-t31', logger },
    );

    expect(providerCalls).toEqual(['standard', 'complex']);
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledWith(expect.objectContaining({
      batchId: 'batch-t31',
      taskIndex: 0,
      loop: 'spec',
      attempt: 0,
      role: 'implementer',
      assignedTier: 'standard',
      usedTier: 'complex',
      reason: 'transport_failure',
      triggeringStatus: 'api_error',
      violatesSeparation: false,
    }));
    expect(fallbackUnavailable).toHaveBeenCalledTimes(1);
    expect(fallbackUnavailable).toHaveBeenCalledWith(expect.objectContaining({
      batchId: 'batch-t31',
      taskIndex: 0,
      loop: 'spec',
      attempt: 0,
      role: 'implementer',
      assignedTier: 'standard',
      reason: 'transport_failure',
    }));

    expect(result.status).toBe('incomplete');
    expect(result.terminationReason).toBe('all_tiers_unavailable');

    const fallbackOverrides = fallback.mock.calls.map(([event]) => ({
      role: event.role,
      loop: event.loop,
      attempt: event.attempt,
      assigned: event.assignedTier,
      used: event.usedTier,
      reason: event.reason,
      triggeringStatus: event.triggeringStatus,
      bothUnavailable: true,
    }));
    expect(fallbackOverrides).toEqual([
      expect.objectContaining({
        role: 'implementer',
        loop: 'spec',
        attempt: 0,
        assigned: 'standard',
        used: 'complex',
        reason: 'transport_failure',
        triggeringStatus: 'api_error',
        bothUnavailable: true,
      }),
    ]);
  });
});
