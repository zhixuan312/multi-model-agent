import { describe, it, expect, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
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
implemented

## Files changed
- src/a.ts: updated

## Normalization decisions

## Validations run
- targeted test: passed

## Deviations from brief

## Unresolved
`;

const SPEC_CHANGES_REQUIRED = `## Summary
changes_required

## Files changed

## Normalization decisions

## Validations run

## Deviations from brief
- fix the implementation

## Unresolved
`;

const REVIEW_APPROVED = `## Summary
approved

## Files changed

## Normalization decisions

## Validations run

## Deviations from brief

## Unresolved
`;

function okResult(output: string): RunResult {
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
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'fallback-transport-')));
  mkdirSync(join(cwd, 'src'));
  writeFileSync(join(cwd, 'src/a.ts'), 'export const before = true;\n');
  return cwd;
}

describe('reviewed lifecycle fallback on transport failure', () => {
  it('keeps spec implementer fallback sticky and records two overrides', async () => {
    const fallbackEvents: Array<Record<string, unknown>> = [];
    const standardRun = vi.fn(async (prompt: string) => {
      if (prompt.startsWith('You are a spec compliance reviewer')) {
        return okResult(REVIEW_APPROVED);
      }
      if (prompt.startsWith('You are a code quality reviewer')) {
        return okResult(REVIEW_APPROVED);
      }
      return apiErrorResult();
    });
    const complexRun = vi.fn(async (prompt: string) => {
      if (prompt.startsWith('You are a spec compliance reviewer')) {
        return okResult(complexRun.mock.calls.length <= 2 ? SPEC_CHANGES_REQUIRED : REVIEW_APPROVED);
      }
      if (prompt.startsWith('You are a code quality reviewer')) {
        return okResult(REVIEW_APPROVED);
      }
      return okResult(STRUCTURED_IMPL_OUTPUT);
    });

    providers.standard = makeProvider('standard', standardRun);
    providers.complex = makeProvider('complex', complexRun);

    const [result] = await runTasks(
      [{
        prompt: 'modify src/a.ts',
        agentType: 'standard',
        cwd: makeCwd(),
        filePaths: ['src/a.ts'],
        reviewPolicy: 'spec_only',
      }],
      makeConfig(),
      {
        batchId: 'batch-fallback-transport',
        logger: {
          fallback: (event: unknown) => fallbackEvents.push(event as Record<string, unknown>),
          fallbackUnavailable: vi.fn(),
          escalation: vi.fn(),
          escalationUnavailable: vi.fn(),
          emit: vi.fn(),
        } as any,
      },
    );

    const overrides = result.agents?.fallbackOverrides ?? [];
    const implOverrides = overrides.filter((entry) => entry.role === 'implementer' && entry.loop === 'spec');

    expect(result.status).toBe('ok');
    expect(result.specReviewStatus).toBe('approved');
    expect(result.agents?.implementer).toBe('complex');
    expect(implOverrides).toHaveLength(2);
    expect(overrides).toHaveLength(2);
    expect(implOverrides).toEqual([
      expect.objectContaining({
        attempt: 0,
        assigned: 'standard',
        used: 'complex',
        reason: 'transport_failure',
        triggeringStatus: 'api_error',
        bothUnavailable: false,
      }),
      expect.objectContaining({
        attempt: 1,
        assigned: 'standard',
        used: 'complex',
        reason: 'transport_failure',
        triggeringStatus: undefined,
        bothUnavailable: false,
      }),
    ]);
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
      expect.objectContaining({
        loop: 'spec',
        attempt: 1,
        role: 'implementer',
        assignedTier: 'standard',
        usedTier: 'complex',
        reason: 'transport_failure',
        triggeringStatus: undefined,
      }),
    ]);
  });
});
