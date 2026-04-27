import { describe, it, expect, vi } from 'vitest';
import type { MultiModelConfig } from '@zhixuan92/multi-model-agent-core';
import { composeTerminalHeadline } from '@zhixuan92/multi-model-agent-core/reporting/compose-terminal-headline';

let specReviewCalls = 0;

const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUSD: 0.001 };

function implementationOutput(slot: string): string {
  return [
    '## Summary',
    `${slot} implementation complete`,
    '',
    '## Files changed',
    '- src/a.ts: updated',
    '',
    '## Normalization decisions',
    '',
    '## Validations run',
    '- npm test: passed',
    '',
    '## Deviations from brief',
    '',
    '## Unresolved',
    '',
  ].join('\n');
}

function reviewOutput(status: 'approved' | 'changes_required', finding = ''): string {
  return [
    '## Summary',
    status,
    '',
    '## Deviations from brief',
    ...(finding ? [`- ${finding}`] : []),
    '',
    '## Unresolved',
    '',
  ].join('\n');
}

vi.mock('@zhixuan92/multi-model-agent-core/provider', () => ({
  createProvider: (slot: 'standard' | 'complex') => ({
    name: slot,
    config: { type: 'openai-compatible' as const, model: `${slot}-model`, baseUrl: 'https://ex.invalid/v1' },
    run: async (prompt: string) => {
      if (typeof prompt === 'string' && prompt.startsWith('You are a spec compliance reviewer')) {
        specReviewCalls++;
        return {
          output: specReviewCalls < 3
            ? reviewOutput('changes_required', `standard implementation still misses spec item ${specReviewCalls}`)
            : reviewOutput('approved'),
          status: 'ok' as const,
          usage,
          turns: 1,
          filesRead: [],
          filesWritten: [],
          toolCalls: [],
          outputIsDiagnostic: false,
          escalationLog: [],
        };
      }
      if (typeof prompt === 'string' && prompt.startsWith('You are a code quality reviewer')) {
        return {
          output: reviewOutput('approved'),
          status: 'ok' as const,
          usage,
          turns: 1,
          filesRead: [],
          filesWritten: [],
          toolCalls: [],
          outputIsDiagnostic: false,
          escalationLog: [],
        };
      }
      return {
        output: implementationOutput(slot),
        status: 'ok' as const,
        usage,
        turns: 1,
        filesRead: ['src/a.ts'],
        filesWritten: ['src/a.ts'],
        toolCalls: ['writeFile(src/a.ts)'],
        outputIsDiagnostic: false,
        escalationLog: [],
      };
    },
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
  defaults: { timeoutMs: 600_000, maxCostUSD: 10, tools: 'full', sandboxPolicy: 'none' },
  server: {
    bind: '127.0.0.1',
    port: 0,
    auth: { tokenFile: '.token' },
    limits: { maxBodyBytes: 1, batchTtlMs: 1, idleProjectTimeoutMs: 1, clarificationTimeoutMs: 1, projectCap: 1, maxBatchCacheSize: 1, maxContextBlockBytes: 1, maxContextBlocksPerProject: 1, shutdownDrainMs: 1 },
    autoUpdateSkills: false,
  },
};

function makeBus(escalations: Array<{ loop: string; attempt: number }>): { emit: (event: any) => void } {
  return {
    emit: (event: any) => {
      if (event.event === 'escalation') {
        escalations.push({ loop: event.loop, attempt: event.attempt });
      }
    },
  };
}

describe('reviewed execution spec-loop escalation', () => {
  it('escalates standard spec rework to complex on attempt 2', async () => {
    specReviewCalls = 0;
    const escalationEvents: Array<{ loop: string; attempt: number }> = [];

    const [result] = await runTasks(
      [{ prompt: 'update src/a.ts to satisfy the spec', agentType: 'standard', reviewPolicy: 'spec_only' }],
      config,
      { batchId: 'batch-escalation-spec-loop', bus: makeBus(escalationEvents) },
    );

    expect(result.status).toBe('ok');
    expect(result.specReviewStatus).toBe('approved');
    expect(result.agents?.implementerHistory).toEqual(['standard', 'standard', 'complex']);
    expect(result.agents?.specReviewerHistory).toEqual(['complex', 'complex', 'standard']);
    expect(escalationEvents).toEqual([{ loop: 'spec', attempt: 2 }]);

    const headline = composeTerminalHeadline({
      tool: 'delegate',
      awaitingClarification: false,
      tasksTotal: 1,
      tasksCompleted: 1,
      policyEscalated: { spec: escalationEvents.some((event) => event.loop === 'spec') },
    });
    expect(headline).toContain('(escalated: spec)');
    expect(result.agents?.implementer).toBe('complex');
  });
});
