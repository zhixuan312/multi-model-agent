import { describe, it, expect, vi } from 'vitest';
import type { MultiModelConfig } from '@zhixuan92/multi-model-agent-core';

// Mock provider: implementer returns ok but with NO files written and NO write tool calls
vi.mock('@zhixuan92/multi-model-agent-core/provider', () => {
  const noArtifactImpl = {
    output: 'Hi there! I greeted the user.',
    status: 'ok' as const,
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUSD: 0.01 },
    turns: 1, filesRead: [], filesWritten: [],
    toolCalls: [],
    outputIsDiagnostic: false, escalationLog: [], briefQualityWarnings: [], retryable: false,
  };
  return {
    createProvider: (slot: string) => ({
      name: slot,
      config: { type: 'openai-compatible' as const, model: `${slot}-model`, baseUrl: 'https://ex.invalid/v1' },
      run: async () => noArtifactImpl,
    }),
  };
});

vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue(''),
}));

import { runTasks } from '@zhixuan92/multi-model-agent-core/run-tasks';

const config: MultiModelConfig = {
  agents: {
    standard: { type: 'openai-compatible', model: 'std', baseUrl: 'https://ex.invalid/v1' },
    complex: { type: 'openai-compatible', model: 'cpx', baseUrl: 'https://ex2.invalid/v1' },
  },
  defaults: { timeoutMs: 600_000, tools: 'full' },
};

describe('not_applicable review status', () => {
  it('returns not_applicable when implementer produces no file artifacts', async () => {
    const results = await runTasks(
      [{ prompt: 'Say hi to the user. Greet them warmly and friendly.', agentType: 'standard' as const, briefQualityPolicy: 'off' as const }],
      config,
    );
    expect(results[0].specReviewStatus).toBe('not_applicable');
    expect(results[0].qualityReviewStatus).toBe('not_applicable');
    expect(results[0].agents?.specReviewer).toBe('not_applicable');
    expect(results[0].agents?.qualityReviewer).toBe('not_applicable');
  });
});