import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentType,
  MultiModelConfig,
  Provider,
  RunResult,
} from '@zhixuan92/multi-model-agent-core';

const providers: Partial<Record<AgentType, Provider>> = {};

vi.mock('@zhixuan92/multi-model-agent-core/provider', () => ({
  createProvider: (slot: AgentType) => {
    const provider = providers[slot];
    if (!provider) throw new Error(`missing provider for ${slot}`);
    return provider;
  },
}));

import { runTasks } from '@zhixuan92/multi-model-agent-core/run-tasks';

const STRUCTURED_IMPL_OUTPUT = `## Summary
implemented via fallback

## Files changed
- src/a.ts: updated

## Normalization decisions

## Validations run
- not run

## Deviations from brief

## Unresolved
`;

function okResult(output = STRUCTURED_IMPL_OUTPUT): RunResult {
  return {
    output,
    status: 'ok',
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, costUSD: 0.001 },
    turns: 1,
    filesRead: ['src/a.ts'],
    filesWritten: ['src/a.ts'],
    toolCalls: ['writeFile(src/a.ts)'],
    outputIsDiagnostic: false,
    escalationLog: [],
    durationMs: 0,
    directoriesListed: [],
    workerStatus: 'done',
    terminationReason: {
      cause: 'finished',
      turnsUsed: 1,
      hasFileArtifacts: true,
      usedShell: false,
      workerSelfAssessment: 'done',
      wasPromoted: false,
    },
  };
}

function apiErrorResult(): RunResult {
  return {
    ...okResult(''),
    status: 'api_error',
    outputIsDiagnostic: true,
    filesRead: [],
    filesWritten: [],
    toolCalls: [],
    workerStatus: 'failed',
    error: 'standard transport failed',
    retryable: true,
  };
}

function makeProvider(slot: AgentType, run: Provider['run']): Provider {
  return {
    name: slot,
    config: {
      type: 'openai-compatible',
      model: `${slot}-model`,
      baseUrl: `https://${slot}.invalid/v1`,
    },
    run,
  };
}

function makeConfig(): MultiModelConfig {
  return {
    agents: {
      standard: { type: 'openai-compatible', model: 'std', baseUrl: 'https://std.invalid/v1' },
      complex: { type: 'openai-compatible', model: 'cpx', baseUrl: 'https://cpx.invalid/v1' },
    },
    defaults: { tools: 'readonly', timeoutMs: 60_000, maxCostUSD: 1, sandboxPolicy: 'cwd-only' },
    server: {} as MultiModelConfig['server'],
  };
}

function makeCwd(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'reviewpolicy-off-fallback-')));
}

describe('reviewPolicy=off initial implementation fallback', () => {
  it('runs the implementation call through the fallback wrapper without firing review events', async () => {
    const fallbackEvents: Array<Record<string, unknown>> = [];
    const emittedEvents: Array<Record<string, unknown>> = [];
    const reviewPrompts: string[] = [];
    const standardRun = vi.fn(async () => apiErrorResult());
    const complexRun = vi.fn(async (prompt: string) => {
      if (prompt.startsWith('You are a spec compliance reviewer') || prompt.startsWith('You are a code quality reviewer')) {
        reviewPrompts.push(prompt);
      }
      return okResult();
    });

    providers.standard = makeProvider('standard', standardRun);
    providers.complex = makeProvider('complex', complexRun);

    const [result] = await runTasks(
      [{
        prompt: 'modify src/a.ts',
        agentType: 'standard',
        cwd: makeCwd(),
        filePaths: ['src/a.ts'],
        reviewPolicy: 'off',
      }],
      makeConfig(),
      {
        batchId: 'batch-reviewpolicy-off-fallback',
        bus: { emit: (event: any) => { emittedEvents.push(event); if (event.event === 'fallback') fallbackEvents.push(event); } },
      },
    );

    expect(result.status).toBe('ok');
    expect(result.workerStatus).toBe('done');
    expect(result.specReviewStatus).toBe('skipped');
    expect(result.qualityReviewStatus).toBe('skipped');
    expect(result.agents?.implementer).toBe('complex');
    expect(result.agents?.specReviewer).toBe('skipped');
    expect(result.agents?.qualityReviewer).toBe('skipped');
    expect(result.agents?.fallbackOverrides).toEqual([
      expect.objectContaining({
        role: 'implementer',
        loop: 'spec',
        attempt: 0,
        assigned: 'standard',
        used: 'complex',
        reason: 'transport_failure',
        triggeringStatus: 'api_error',
        bothUnavailable: false,
      }),
    ]);

    expect(standardRun).toHaveBeenCalledTimes(3);
    expect(complexRun).toHaveBeenCalledTimes(1);
    expect(reviewPrompts).toEqual([]);
    expect(fallbackEvents).toEqual([
      expect.objectContaining({
        loop: 'spec',
        attempt: 0,
        role: 'implementer',
        assignedTier: 'standard',
        usedTier: 'complex',
        reason: 'transport_failure',
        triggeringStatus: 'api_error',
      }),
    ]);
    expect(emittedEvents.filter((event) => event.event === 'review_decision')).toEqual([]);
    expect(emittedEvents.filter((event) => String(event.to ?? '').includes('review'))).toEqual([]);
  });
});
