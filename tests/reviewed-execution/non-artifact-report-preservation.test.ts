import { describe, it, expect, vi } from 'vitest';
import type { MultiModelConfig } from '@zhixuan92/multi-model-agent-core';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workerOutput = '## Summary\nAuthoritative answer text.\n## Citations\n- src/a.ts:1 — c\n## Confidence\nhigh — verified\n';

vi.mock('@zhixuan92/multi-model-agent-core/provider', () => ({
  createProvider: (slot: string) => ({
    name: slot,
    config: { type: 'openai-compatible' as const, model: `${slot}-model`, baseUrl: 'https://ex.invalid/v1' },
    run: async () => ({
      output: workerOutput,
      status: 'ok' as const,
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUSD: 0.01 },
      turns: 1,
      filesRead: [],
      filesWritten: [],
      toolCalls: [],
      outputIsDiagnostic: false,
      escalationLog: [],
      briefQualityWarnings: [],
      retryable: false,
    }),
  }),
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('// mock file content\nconst x = 1;\n'),
}));

import { runTasks } from '@zhixuan92/multi-model-agent-core/run-tasks';

const config: MultiModelConfig = {
  agents: {
    standard: { type: 'openai-compatible', model: 'std', baseUrl: 'https://ex.invalid/v1' },
    complex: { type: 'openai-compatible', model: 'cpx', baseUrl: 'https://ex2.invalid/v1' },
  },
  defaults: { timeoutMs: 600_000, maxCostUSD: 1, tools: 'readonly', sandboxPolicy: 'cwd-only' },
  server: {} as any,
};

describe('non-artifact report preservation (reviewPolicy: off)', () => {
  it('does not replace the worker structured report with a no-artifacts wrapper', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'preserve-')));
    const [result] = await runTasks(
      [{ prompt: 'go', agentType: 'standard' as const, cwd, reviewPolicy: 'off' } as any],
      config,
    );

    expect(result.output).toContain('Authoritative answer text.');
    expect(result.structuredReport?.summary).toBe('Authoritative answer text.');
    expect(result.structuredReport?.summary).not.toContain('[No artifacts]');
    expect(result.specReviewStatus).toBe('skipped');
    expect(result.qualityReviewStatus).toBe('skipped');
  });
});
