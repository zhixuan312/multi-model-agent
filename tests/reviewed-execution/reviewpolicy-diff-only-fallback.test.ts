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

vi.mock('@zhixuan92/multi-model-agent-core/providers/provider-factory', () => ({
  createProvider: (slot: AgentType) => {
    const provider = providers[slot];
    if (!provider) throw new Error(`missing provider for ${slot}`);
    return provider;
  },
}));

vi.mock('@zhixuan92/multi-model-agent-core/review/evidence', () => ({
  buildEvidence: vi.fn(async () => ({
    block: 'diff evidence',
    diffTruncated: false,
    fullDiff: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-export const before = true;\n+export const after = true;\n',
  })),
}));

import { runTasks } from '@zhixuan92/multi-model-agent-core/lifecycle/run-tasks';

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

function okResult(output: string, filesWritten: string[] = ['src/a.ts']): RunResult {
  return {
    output,
    status: 'ok',
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, costUSD: 0.001 },
    turns: 1,
    filesRead: ['src/a.ts'],
    filesWritten,
    toolCalls: ['writeFile(src/a.ts)'],
    outputIsDiagnostic: false,
    escalationLog: [],
    durationMs: 0,
    directoriesListed: [],
    workerStatus: 'done',
    terminationReason: {
      cause: 'finished',
      turnsUsed: 1,
      hasFileArtifacts: filesWritten.length > 0,
      usedShell: false,
      workerSelfAssessment: 'done',
      wasPromoted: false,
    },
  };
}

function apiErrorResult(): RunResult {
  return {
    output: 'standard diff review transport failed',
    status: 'api_error',
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: null },
    turns: 0,
    filesRead: [],
    filesWritten: [],
    toolCalls: [],
    outputIsDiagnostic: true,
    escalationLog: [],
    durationMs: 0,
    directoriesListed: [],
    workerStatus: 'failed',
    error: 'standard diff review transport failed',
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
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'diff-only-fallback-')));
  mkdirSync(join(cwd, 'src'));
  writeFileSync(join(cwd, 'src/a.ts'), 'export const before = true;\n');
  return cwd;
}

describe('Item 3: diff_review reject sets terminationReason.cause = error', () => {
  it('reject branch produces status=error and overwrites terminationReason', async () => {
    const standardRun = vi.fn(async (_prompt: string) => {
      return okResult(STRUCTURED_IMPL_OUTPUT);
    });
    const complexRun = vi.fn(async (prompt: string) => {
      if (prompt.includes('You are reviewing a mechanical refactor')) {
        return { output: 'REJECT: implementation introduces bugs' };
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
        reviewPolicy: 'diff_only',
      }],
      makeConfig(),
      { batchId: 'batch-diff-only-reject' },
    );

    expect(result.status).toBe('error');
    expect(result.workerStatus).toBe('failed');
    expect(result.errorCode).toBe('diff_review_rejected');
    expect(result.terminationReason).toBeDefined();
    if (result.terminationReason && typeof result.terminationReason === 'object') {
      expect(result.terminationReason.cause).toBe('error');
      expect(result.terminationReason.turnsUsed).toBe(1);
      expect(result.terminationReason.hasFileArtifacts).toBe(true);
      expect(result.terminationReason.usedShell).toBe(false);
    }
  });
});

describe('reviewPolicy=diff_only fallback', () => {
  it('records diff-review fallback with loop=diff and role=diffReviewer', async () => {
    const fallbackEvents: Array<Record<string, unknown>> = [];
    const standardRun = vi.fn(async (prompt: string) => {
      if (prompt.includes('You are reviewing a mechanical refactor')) {
        return { output: 'APPROVE' };
      }
      return okResult(STRUCTURED_IMPL_OUTPUT);
    });
    const complexRun = vi.fn(async (prompt: string) => {
      if (prompt.includes('You are reviewing a mechanical refactor')) {
        return apiErrorResult();
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
        reviewPolicy: 'diff_only',
      }],
      makeConfig(),
      {
        batchId: 'batch-diff-only-fallback',
        bus: { emit: (event: any) => { if (event.event === 'fallback') fallbackEvents.push(event); } },
      },
    );

    const overrides = result.agents?.fallbackOverrides ?? [];

    // R3: diff reviewer on complex fails, falls back to standard, but standard
    // shares identity with the implementer → forbidden → both unavailable.
    // The lifecycle terminates before setting review statuses.
    expect(result.status === 'error' || result.status === 'incomplete').toBe(true);
    expect(standardRun).toHaveBeenCalled();
    expect(complexRun).toHaveBeenCalled();
    // overrides may be empty when both tiers become unavailable
    expect(fallbackEvents.length).toBeGreaterThanOrEqual(1);
    expect(fallbackEvents[0]).toMatchObject({
      loop: 'diff',
      attempt: 0,
      role: 'diffReviewer',
      assignedTier: 'complex',
      reason: 'transport_failure',
      triggeringStatus: 'api_error',
    });
  });
});
