import { describe, it, expect, vi } from 'vitest';
import type { MultiModelConfig } from '@zhixuan92/multi-model-agent-core';

import { EventBus } from '../../packages/core/src/observability/bus.js';
import type { EventType, EventSink } from '../../packages/core/src/observability/bus.js';

const capturedEvents: EventType[] = [];

class CaptureSink implements EventSink {
  readonly name = 'capture';
  emit(event: EventType): void {
    capturedEvents.push(event);
  }
}

function resetCaptured(): void {
  capturedEvents.length = 0;
}

const VALID_EVIDENCE = 'src/auth/login.ts:89 — the property access is unguarded against undefined req.body.user';

// Worker output that the runtime feeds to the implementer mock — embeds a valid
// findings[] JSON block that the annotation-path reviewer will extract.
const WORKER_OUTPUT_WITH_FINDINGS = [
  '## Summary',
  'analysis complete',
  '',
  '## Findings',
  '```json',
  JSON.stringify([
    { id: 'F1', severity: 'high', claim: 'Issue A', evidence: VALID_EVIDENCE },
    { id: 'F2', severity: 'medium', claim: 'Issue B', evidence: VALID_EVIDENCE, suggestion: 'wrap it' },
  ]),
  '```',
  '',
  '## Deviations from brief',
  '',
  '## Unresolved',
  '',
].join('\n');

const REVIEWER_ANNOTATION_OUTPUT = [
  'Annotated.',
  '```json',
  JSON.stringify([
    { id: 'F1', reviewerConfidence: 85 },
    { id: 'F2', reviewerConfidence: 40, reviewerSeverity: 'low' },
  ]),
  '```',
].join('\n');

vi.mock('@zhixuan92/multi-model-agent-core/provider', () => ({
  createProvider: (slot: string) => ({
    name: slot,
    config: { type: 'openai-compatible' as const, model: `${slot}-model`, baseUrl: 'https://ex.invalid/v1' },
    run: vi.fn(async (prompt: string) => {
      // The reviewer prompts include the rubric "How to score `reviewerConfidence`"
      const isReviewer = typeof prompt === 'string' && prompt.includes('reviewerConfidence');
      if (isReviewer) {
        return {
          output: REVIEWER_ANNOTATION_OUTPUT,
          status: 'ok' as const,
          usage: { inputTokens: 50, outputTokens: 25, totalTokens: 75, costUSD: 0.005 },
          turns: 1,
          filesRead: [],
          filesWritten: [],
          toolCalls: [],
          outputIsDiagnostic: false,
          escalationLog: [],
        };
      }
      // implementer
      return {
        output: WORKER_OUTPUT_WITH_FINDINGS,
        status: 'ok' as const,
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUSD: 0.01 },
        turns: 1,
        filesRead: ['src/a.ts'],
        filesWritten: ['src/report.md'],
        toolCalls: ['readFile(src/a.ts)', 'writeFile(src/report.md)'],
        outputIsDiagnostic: false,
        escalationLog: [],
      };
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
  server: {
    bind: '127.0.0.1',
    port: 0,
    auth: { tokenFile: '.token' },
    limits: { maxBodyBytes: 1, batchTtlMs: 1, idleProjectTimeoutMs: 1, clarificationTimeoutMs: 1, projectCap: 1, maxBatchCacheSize: 1, maxContextBlockBytes: 1, maxContextBlocksPerProject: 1, shutdownDrainMs: 1 },
    autoUpdateSkills: false,
  },
};

import { buildAuditQualityPrompt } from '../../packages/core/src/review/quality-only-prompts.js';

function makeBus(): { bus: EventBus; sink: CaptureSink } {
  const sink = new CaptureSink();
  const bus = new EventBus([sink]);
  return { bus, sink };
}

describe('read-only review telemetry (annotation model, 3.8.1)', () => {
  it('emits read_only_review.quality with verdict=annotated and annotation summary fields', async () => {
    resetCaptured();

    const { bus } = makeBus();
    const [result] = await runTasks(
      [{ prompt: 'audit src/', agentType: 'standard', reviewPolicy: 'quality_only', cwd: '/tmp/test' }],
      config,
      { route: 'audit', batchId: '00000000-0000-0000-0000-000000000001', bus, qualityReviewPromptBuilder: buildAuditQualityPrompt },
    );

    expect(result.status).toBe('ok');
    const qualityEvents = capturedEvents.filter((e) => e.event === 'read_only_review.quality');
    expect(qualityEvents).toHaveLength(1);
    expect(qualityEvents[0]).toMatchObject({
      event: 'read_only_review.quality',
      route: 'audit',
      verdict: 'annotated',
      iterationIndex: 1,
      findingsReviewed: 2,
      severityCorrections: 1,
      // meanConfidence: (85 + 40) / 2 = 62.5
      meanConfidence: 62.5,
    });
  });

  it('does NOT emit read_only_review.rework anymore (rework loop deleted in 3.8.1)', async () => {
    resetCaptured();

    const { bus } = makeBus();
    await runTasks(
      [{ prompt: 'audit src/', agentType: 'standard', reviewPolicy: 'quality_only', cwd: '/tmp/test' }],
      config,
      { route: 'audit', batchId: '00000000-0000-0000-0000-000000000002', bus, qualityReviewPromptBuilder: buildAuditQualityPrompt },
    );

    const reworkEvents = capturedEvents.filter((e) => e.event === 'read_only_review.rework');
    expect(reworkEvents).toHaveLength(0);
  });

  it('emits read_only_review.terminal with roundsUsed=1 and finalQualityVerdict=annotated', async () => {
    resetCaptured();

    const { bus } = makeBus();
    await runTasks(
      [{ prompt: 'audit src/', agentType: 'standard', reviewPolicy: 'quality_only', cwd: '/tmp/test' }],
      config,
      { route: 'audit', batchId: '00000000-0000-0000-0000-000000000003', bus, qualityReviewPromptBuilder: buildAuditQualityPrompt },
    );

    const terminalEvents = capturedEvents.filter((e) => e.event === 'read_only_review.terminal');
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]).toMatchObject({
      event: 'read_only_review.terminal',
      route: 'audit',
      roundsUsed: 1,
      finalQualityVerdict: 'annotated',
    });
  });

  it('event order is implementing → quality → terminal (no rework slot in between)', async () => {
    resetCaptured();

    const { bus } = makeBus();
    await runTasks(
      [{ prompt: 'audit src/', agentType: 'standard', reviewPolicy: 'quality_only', cwd: '/tmp/test' }],
      config,
      { route: 'audit', batchId: '00000000-0000-0000-0000-000000000004', bus, qualityReviewPromptBuilder: buildAuditQualityPrompt },
    );

    const rorEventNames = capturedEvents
      .map((e) => e.event)
      .filter((n) => n.startsWith('read_only_review.'));

    expect(rorEventNames).toEqual(['read_only_review.quality', 'read_only_review.terminal']);
  });
});
