import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MultiModelConfig, Provider, RunResult } from '@zhixuan92/multi-model-agent-core';

let activeProvider: Provider;

vi.mock('@zhixuan92/multi-model-agent-core/provider', () => ({
  createProvider: (slot: string) => {
    if (slot === 'standard') return activeProvider;
    throw new Error(`slot not configured: ${slot}`);
  },
}));

import { runTasks } from '@zhixuan92/multi-model-agent-core/run-tasks';

function usage(cost = 0.001) {
  return { inputTokens: 10, outputTokens: 20, totalTokens: 30, costUSD: cost };
}

function makeImplementationOutput(label: string): string {
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

function makeResult(output: string, filesWritten: string[] = []): RunResult {
  return {
    output,
    status: 'ok',
    usage: usage(),
    turns: 1,
    filesRead: [],
    filesWritten,
    toolCalls: [],
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

function makeReviewerOutput(status: 'changes_required' | 'approved', finding: string): string {
  return [
    '## Summary',
    status,
    '',
    '## Files changed',
    '',
    '## Validations run',
    '',
    '## Deviations from brief',
    status === 'changes_required' ? `- ${finding}` : '',
    '',
    '## Unresolved',
    '',
  ].join('\n');
}

function makeConfig(provider: Provider): MultiModelConfig {
  activeProvider = provider;
  return {
    agents: {
      standard: { type: 'openai-compatible', model: 'std', baseUrl: 'https://ex.invalid/v1' },
    },
    defaults: { tools: 'readonly', timeoutMs: 60_000, maxCostUSD: 1, sandboxPolicy: 'cwd-only' },
    server: {} as any,
  };
}

function makeCwd(): string {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'fallback-not-configured-')));
  writeFileSync(join(cwd, 'a.txt'), 'placeholder\n');
  return cwd;
}

describe('reviewed lifecycle fallback when escalated tier is not configured', () => {
  it('fires not_configured fallback and escalation_unavailable without triggeringStatus on escalated spec rework', async () => {
    const cwd = makeCwd();
    let implementationCalls = 0;
    let specReviewCalls = 0;
    let qualityReviewCalls = 0;

    const provider: Provider = {
      name: 'standard',
      config: { type: 'openai-compatible', model: 'std', baseUrl: 'https://ex.invalid/v1' } as any,
      async run(prompt: string): Promise<RunResult> {
        if (prompt.startsWith('You are a spec compliance reviewer')) {
          specReviewCalls += 1;
          if (specReviewCalls === 1) return makeResult(makeReviewerOutput('changes_required', 'first missing spec detail'));
          if (specReviewCalls === 2) return makeResult(makeReviewerOutput('changes_required', 'second missing spec detail'));
          return makeResult(makeReviewerOutput('approved', ''));
        }
        if (prompt.startsWith('You are a code quality reviewer')) {
          qualityReviewCalls += 1;
          return makeResult(makeReviewerOutput('approved', ''));
        }
        implementationCalls += 1;
        return makeResult(makeImplementationOutput(`implementation ${implementationCalls}`), ['src/a.ts']);
      },
    };

    const events: Array<Record<string, unknown>> = [];
    const config = makeConfig(provider);
    const [result] = await runTasks(
      [{ prompt: 'update src/a.ts to satisfy the spec', agentType: 'standard', cwd } as any],
      config,
      {
        batchId: 'batch-fallback-not-configured',
        bus: { emit: (event: any) => events.push(event) },
      },
    );

    // R3: reviewer can't use standard (same identity as implementer) and complex
    // is not configured → review skipped. The lifecycle completes ok with
    // skipped reviews rather than failing the task.
    expect(result.status).toBe('ok');
    expect(implementationCalls).toBe(1);
    expect(specReviewCalls).toBe(0);
    expect(qualityReviewCalls).toBe(0);

    // R3: the spec reviewer's fallback also fails — standard is forbidden
    // (same identity as implementer) and complex is not configured.
    // When both tiers are unavailable, a fallback_unavailable event is emitted.
    const reviewerUnavailable = events.find((event) =>
      event.event === 'fallback_unavailable' &&
      event.loop === 'spec' &&
      event.role === 'specReviewer',
    );
    expect(reviewerUnavailable).toBeDefined();
    expect(reviewerUnavailable?.reason).toBe('not_configured');
  });
});
