import { describe, it, expect, vi } from 'vitest';
import type { MultiModelConfig } from '@zhixuan92/multi-model-agent-core';
import type { DiagnosticLogger } from '@zhixuan92/multi-model-agent-core/diagnostics/disconnect-log';

const calls: Array<{ slot: string; kind: 'implement' | 'spec_review' | 'quality_review'; prompt: string }> = [];

const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUSD: 0.001 };
const unchangedFinding = 'missing required audit trail';

function implementationOutput(slot: string, n: number): string {
  return [
    '## Summary',
    `${slot} implementation ${n} complete`,
    '',
    '## Files changed',
    '- src/a.ts: updated',
    '',
    '## Normalization decisions',
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

function specReviewOutput(finding: string): string {
  return [
    '## Summary',
    'changes_required',
    '',
    '## Deviations from brief',
    `- ${finding}`,
    '',
    '## Unresolved',
    '',
  ].join('\n');
}

function qualityReviewOutput(): string {
  return [
    '## Summary',
    'approved',
    '',
    '## Deviations from brief',
    '',
    '## Unresolved',
    '',
  ].join('\n');
}

function result(output: string) {
  return {
    output,
    status: 'ok' as const,
    usage,
    turns: 1,
    filesRead: ['src/a.ts'],
    filesWritten: ['src/a.ts'],
    toolCalls: ['readFile(src/a.ts)', 'writeFile(src/a.ts)'],
    outputIsDiagnostic: false,
    escalationLog: [],
    briefQualityWarnings: [],
    retryable: false,
  };
}

let implCount = 0;
let specReviewCount = 0;

vi.mock('@zhixuan92/multi-model-agent-core/provider', () => ({
  createProvider: (slot: string) => ({
    name: slot,
    config: { type: 'openai-compatible' as const, model: `${slot}-model`, baseUrl: 'https://ex.invalid/v1' },
    run: vi.fn(async (prompt: string) => {
      if (prompt.startsWith('You are a spec compliance reviewer')) {
        calls.push({ slot, kind: 'spec_review', prompt });
        specReviewCount += 1;
        return result(specReviewOutput(unchangedFinding));
      }

      if (prompt.startsWith('You are a code quality reviewer')) {
        calls.push({ slot, kind: 'quality_review', prompt });
        return result(qualityReviewOutput());
      }

      calls.push({ slot, kind: 'implement', prompt });
      implCount += 1;
      return result(implementationOutput(slot, implCount));
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
  defaults: { timeoutMs: 600_000, maxCostUSD: 10, tools: 'full', sandboxPolicy: 'none' },
};

function makeLogger(escalations: Array<{ loop: string; attempt: number }>): DiagnosticLogger {
  return {
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
    emit: () => {},
    batchCompleted: () => {},
    batchFailed: () => {},
    escalation: (params) => { escalations.push({ loop: params.loop, attempt: params.attempt }); },
    escalationUnavailable: () => {},
    fallback: () => {},
    fallbackUnavailable: () => {},
  };
}

describe('reviewed lifecycle no-progress break before spec escalation', () => {
  it('stops after standard rework when spec findings are unchanged and does not escalate', async () => {
    calls.length = 0;
    implCount = 0;
    specReviewCount = 0;
    const escalationEvents: Array<{ loop: string; attempt: number }> = [];

    const [result] = await runTasks(
      [{ prompt: 'update src/a.ts to satisfy the spec', agentType: 'standard', reviewPolicy: 'spec_only' }],
      config,
      { batchId: 'batch-no-progress-before-escalation', logger: makeLogger(escalationEvents) },
    );

    expect(result.status).toBe('incomplete');
    expect(result.specReviewStatus).toBe('changes_required');
    expect(result.qualityReviewStatus).toBe('skipped');
    expect(result.agents?.implementerHistory).toEqual(['standard', 'standard']);
    expect(result.agents?.specReviewerHistory).toEqual(['complex', 'complex']);
    expect(escalationEvents).toEqual([]);

    const implementations = calls.filter((call) => call.kind === 'implement');
    const specReviews = calls.filter((call) => call.kind === 'spec_review');

    expect(implementations.map((call) => call.slot)).toEqual(['standard', 'standard']);
    expect(specReviews.map((call) => call.slot)).toEqual(['complex', 'complex']);
    expect(specReviewCount).toBe(2);
    expect(implementations[1].prompt).toContain('## Spec Review Feedback (round 1):');
    expect(implementations[1].prompt).toContain(`- ${unchangedFinding}`);
  });
});
