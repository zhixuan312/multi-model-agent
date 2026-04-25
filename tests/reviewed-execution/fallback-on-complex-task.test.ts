import { describe, it, expect, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AgentType, MultiModelConfig, Provider, RunResult } from '@zhixuan92/multi-model-agent-core';

const providers: Partial<Record<AgentType, Provider>> = {};

vi.mock('@zhixuan92/multi-model-agent-core/provider', () => ({
  createProvider: (slot: AgentType) => providers[slot],
}));

import { runTasks } from '@zhixuan92/multi-model-agent-core/run-tasks';

function makeConfig(): MultiModelConfig {
  return {
    agents: {
      standard: { type: 'openai-compatible', model: 'std', baseUrl: 'https://standard.invalid/v1' },
      complex: { type: 'openai-compatible', model: 'cpx', baseUrl: 'https://complex.invalid/v1' },
    },
    defaults: { tools: 'readonly', timeoutMs: 60_000, maxCostUSD: 1, sandboxPolicy: 'cwd-only' },
    server: {} as MultiModelConfig['server'],
  };
}

function makeCwd(): string {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'fallback-on-complex-task-')));
  const target = join(cwd, 'src/a.ts');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, 'export const before = true;\n');
  return cwd;
}

function runResult(output: string, status: RunResult['status'] = 'ok', filesWritten: string[] = []): RunResult {
  return {
    output,
    status,
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, costUSD: 0.001 },
    turns: 1,
    filesRead: filesWritten,
    filesWritten,
    toolCalls: [],
    outputIsDiagnostic: status !== 'ok',
    escalationLog: [],
    durationMs: 0,
    directoriesListed: [],
    workerStatus: status === 'ok' ? 'done' : 'failed',
    ...(status === 'ok'
      ? {
          terminationReason: {
            cause: 'finished' as const,
            turnsUsed: 1,
            hasFileArtifacts: filesWritten.length > 0,
            usedShell: false,
            workerSelfAssessment: 'done' as const,
            wasPromoted: false,
          },
        }
      : { error: 'complex transport failed', retryable: true }),
  };
}

function implementationOutput(label: string): string {
  return [
    '## Summary',
    label,
    '',
    '## Files changed',
    '- src/a.ts: updated',
    '',
    '## Validations run',
    '- targeted test: passed',
    '',
    '## Deviations from brief',
    '',
    '## Unresolved',
    '',
  ].join('\n');
}

function reviewerOutput(status: 'changes_required' | 'approved'): string {
  return [
    '## Summary',
    status,
    '',
    '## Files changed',
    '',
    '## Validations run',
    '',
    '## Deviations from brief',
    status === 'changes_required' ? '- fix the implementation' : '',
    '',
    '## Unresolved',
    '',
  ].join('\n');
}

function makeProvider(slot: AgentType, run: Provider['run']): Provider {
  return {
    name: slot,
    config: { type: 'openai-compatible', model: `${slot}-model`, baseUrl: `https://${slot}.invalid/v1` },
    run,
  };
}

describe('reviewed lifecycle fallback on complex task transport failure', () => {
  it('falls downward from complex to standard at runtime and records the override', async () => {
    const calls: string[] = [];
    const fallbackEvents: Array<Record<string, unknown>> = [];

    let complexAttempts = 0;
    providers.complex = makeProvider('complex', vi.fn(async () => {
      complexAttempts += 1;
      calls.push('complex:initial-impl');
      return runResult('', 'api_error');
    }));

    providers.standard = makeProvider('standard', vi.fn(async (prompt: string) => {
      if (prompt.startsWith('You are a spec compliance reviewer')) {
        calls.push('standard:spec-review');
        return runResult(reviewerOutput('approved'));
      }
      if (prompt.startsWith('You are a code quality reviewer')) {
        calls.push('standard:quality-review');
        return runResult(reviewerOutput('approved'));
      }
      calls.push('standard:fallback-impl');
      return runResult(implementationOutput('fallback implementation complete'), 'ok', ['src/a.ts']);
    }));

    const [result] = await runTasks(
      [{
        prompt: 'Update src/a.ts. Done when targeted test passes.',
        agentType: 'complex',
        cwd: makeCwd(),
        filePaths: ['src/a.ts'],
        reviewPolicy: 'spec_only',
      }],
      makeConfig(),
      {
        batchId: 'batch-fallback-on-complex-task',
        logger: {
          fallback: (event: unknown) => fallbackEvents.push(event as Record<string, unknown>),
          fallbackUnavailable: vi.fn(),
          escalation: vi.fn(),
          escalationUnavailable: vi.fn(),
          emit: vi.fn(),
        } as any,
      },
    );

    expect(result.status).toBe('ok');
    expect(result.specReviewStatus).toBe('approved');
    expect(result.agents?.implementer).toBe('standard');
    expect(result.agents?.fallbackOverrides).toEqual([
      expect.objectContaining({
        role: 'implementer',
        loop: 'spec',
        attempt: 0,
        assigned: 'complex',
        used: 'standard',
        reason: 'transport_failure',
        triggeringStatus: 'api_error',
        bothUnavailable: false,
      }),
    ]);
    expect(fallbackEvents).toEqual([
      expect.objectContaining({
        batchId: 'batch-fallback-on-complex-task',
        taskIndex: 0,
        loop: 'spec',
        attempt: 0,
        role: 'implementer',
        assignedTier: 'complex',
        usedTier: 'standard',
        reason: 'transport_failure',
        triggeringStatus: 'api_error',
        violatesSeparation: false,
      }),
    ]);
    expect(complexAttempts).toBeGreaterThan(0);
    expect(calls.slice(-2)).toEqual([
      'standard:fallback-impl',
      'standard:spec-review',
    ]);
  });
});
