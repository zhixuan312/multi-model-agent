import { describe, it, expect, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { MultiModelConfig, Provider, RunResult } from '@zhixuan92/multi-model-agent-core';

const providers: Partial<Record<'standard' | 'complex', Provider>> = {};

vi.mock('@zhixuan92/multi-model-agent-core/provider', () => ({
  createProvider: (slot: 'standard' | 'complex') => {
    const provider = providers[slot];
    if (!provider) throw new Error(`missing provider for ${slot}`);
    return provider;
  },
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('// mocked implementer file content\n'),
}));

import { runTasks } from '@zhixuan92/multi-model-agent-core/run-tasks';

function makeConfig(): MultiModelConfig {
  return {
    agents: {
      standard: { type: 'openai-compatible', model: 'std', baseUrl: 'https://standard.invalid/v1' },
      complex: { type: 'openai-compatible', model: 'cpx', baseUrl: 'https://complex.invalid/v1' },
    },
    defaults: { tools: 'readonly', timeoutMs: 60_000, maxCostUSD: 1, sandboxPolicy: 'cwd-only' },
    server: {} as any,
  };
}

function makeCwd(): string {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'complex-tier-escalation-')));
  const target = join(cwd, 'src/a.ts');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, '// mocked implementation artifact\n');
  return cwd;
}

function result(output: string, provider: 'standard' | 'complex'): RunResult {
  return {
    output,
    status: 'ok',
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, costUSD: 0.001 },
    turns: 1,
    filesRead: [],
    filesWritten: provider === 'complex' ? ['src/a.ts'] : [],
    toolCalls: [],
    outputIsDiagnostic: false,
    escalationLog: [],
    durationMs: 0,
    directoriesListed: [],
    workerStatus: 'done',
    terminationReason: {
      cause: 'finished',
      turnsUsed: 1,
      hasFileArtifacts: provider === 'complex',
      usedShell: false,
      workerSelfAssessment: 'done',
      wasPromoted: false,
    },
  };
}

function implementerOutput(round: string): string {
  return `## Summary\n${round} implementation complete\n\n## Files changed\n- src/a.ts: updated\n\n## Validations run\n- targeted check: passed\n\n## Deviations from brief\n\n## Unresolved\n`;
}

function reviewerOutput(status: 'approved' | 'changes_required'): string {
  if (status === 'approved') {
    return '## Summary\napproved\n\n## Deviations from brief\n\n## Unresolved\n';
  }
  return '## Summary\nchanges_required\n\n## Deviations from brief\n- fix requested\n\n## Unresolved\n';
}

function makeProvider(slot: 'standard' | 'complex', calls: string[]): Provider {
  let specReviews = 0;
  let qualityReviews = 0;
  return {
    name: slot,
    config: { type: 'openai-compatible', model: slot === 'complex' ? 'cpx' : 'std', baseUrl: `https://${slot}.invalid/v1` },
    async run(prompt: string): Promise<RunResult> {
      if (prompt.includes('You are a spec compliance reviewer')) {
        calls.push(`${slot}:spec-review`);
        specReviews += 1;
        return result(reviewerOutput(specReviews === 1 ? 'changes_required' : 'approved'), slot);
      }
      if (prompt.includes('You are a code quality reviewer')) {
        calls.push(`${slot}:quality-review`);
        qualityReviews += 1;
        return result(reviewerOutput(qualityReviews === 1 ? 'changes_required' : 'approved'), slot);
      }
      const reworkKind = prompt.includes('Quality Review Feedback')
        ? 'quality-rework'
        : prompt.includes('Spec Review Feedback')
          ? 'spec-rework'
          : 'initial-impl';
      calls.push(`${slot}:${reworkKind}`);
      return result(implementerOutput(reworkKind), slot);
    },
  };
}

describe('complex-tier reviewed execution escalation policy', () => {
  it('complex task uses uniform complex tables and emits no escalation event', async () => {
    const calls: string[] = [];
    providers.standard = makeProvider('standard', calls);
    providers.complex = makeProvider('complex', calls);

    const escalation = vi.fn();
    const emitted: string[] = [];
    const logger = {
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
      emit: vi.fn((event: { event: string }) => { emitted.push(event.event); }),
      batchCompleted: vi.fn(),
      batchFailed: vi.fn(),
      escalation,
      escalationUnavailable: vi.fn(),
      fallback: vi.fn(),
      fallbackUnavailable: vi.fn(),
    };

    const [res] = await runTasks(
      [{
        prompt: 'Update src/a.ts. Done when targeted check passes.',
        agentType: 'complex',
        cwd: makeCwd(),
        filePaths: ['src/a.ts'],
        reviewPolicy: 'full',
      }],
      makeConfig(),
      { batchId: 'batch-complex-tier', logger: logger as any },
    );

    expect(res.status).toBe('ok');
    expect(res.specReviewStatus).toBe('approved');
    expect(res.qualityReviewStatus).toBe('approved');
    expect(res.agents?.implementer).toBe('complex');
    expect(res.agents?.implementerHistory).toEqual(['complex', 'complex', 'complex']);
    expect(res.agents?.specReviewer).toBe('standard');
    expect(res.agents?.specReviewerHistory).toEqual(['standard', 'standard']);
    expect(res.agents?.qualityReviewer).toBe('standard');
    expect(res.agents?.qualityReviewerHistory).toEqual(['standard', 'standard']);
    expect(res.agents?.fallbackOverrides).toBeUndefined();

    expect(calls).toEqual([
      'complex:initial-impl',
      'standard:spec-review',
      'complex:spec-rework',
      'standard:spec-review',
      'standard:quality-review',
      'complex:quality-rework',
      'standard:quality-review',
    ]);
    expect(escalation).not.toHaveBeenCalled();
    expect(emitted).not.toContain('escalation');
  });
});
