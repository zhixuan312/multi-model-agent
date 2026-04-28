import { describe, it, expect, vi } from 'vitest';
import type { MultiModelConfig } from '@zhixuan92/multi-model-agent-core';

// ---------------------------------------------------------------------------
// Capturing EventSink
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Mock providers — implementer + quality reviewer
// ---------------------------------------------------------------------------

let qualityReviewResult: 'approved' | 'changes_required' = 'approved';
let qualityReviewFindings: string[] = [];

vi.mock('@zhixuan92/multi-model-agent-core/provider', () => ({
  createProvider: (slot: string) => ({
    name: slot,
    config: { type: 'openai-compatible' as const, model: `${slot}-model`, baseUrl: 'https://ex.invalid/v1' },
    run: vi.fn(async (prompt: string) => {
      if (typeof prompt === 'string' && prompt.startsWith('You are a code quality reviewer')) {
        return {
          output: [
            '## Summary',
            qualityReviewResult,
            '',
            ...(qualityReviewFindings.length > 0
              ? ['## Deviations from brief', ...qualityReviewFindings.map((f: string) => `- ${f}`)]
              : []),
            '## Unresolved',
            '',
          ].join('\n'),
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
        output: [
          '## Summary',
          'analysis complete',
          '',
          '## Findings',
          '- finding 1: something to review',
          '',
          '## Deviations from brief',
          '',
          '## Unresolved',
          '',
        ].join('\n'),
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

function makeBus(): { bus: EventBus; sink: CaptureSink } {
  const sink = new CaptureSink();
  const bus = new EventBus([sink]);
  return { bus, sink };
}

describe('read-only review telemetry', () => {
  it('emits read_only_review.quality with verdict=approved and findingsReviewed', async () => {
    resetCaptured();
    qualityReviewResult = 'approved';
    qualityReviewFindings = [];

    const { bus } = makeBus();
    const [result] = await runTasks(
      [{ prompt: 'audit src/', agentType: 'standard', reviewPolicy: 'quality_only', cwd: '/tmp/test' }],
      config,
      { route: 'audit', batchId: '00000000-0000-0000-0000-000000000001', bus },
    );

    expect(result.status).toBe('ok');
    const qualityEvents = capturedEvents.filter((e) => e.event === 'read_only_review.quality');
    expect(qualityEvents).toHaveLength(1);
    expect(qualityEvents[0]).toMatchObject({
      event: 'read_only_review.quality',
      route: 'audit',
      verdict: 'approved',
      iterationIndex: 1,
      findingsReviewed: 0,
      findingsFlagged: 0,
    });
  });

  it('emits read_only_review.rework when reviewer flags changes_required', async () => {
    resetCaptured();
    qualityReviewResult = 'changes_required';
    qualityReviewFindings = ['deviation: missing key audit section'];

    const { bus } = makeBus();
    await runTasks(
      [{ prompt: 'audit src/', agentType: 'standard', reviewPolicy: 'quality_only', cwd: '/tmp/test' }],
      config,
      { route: 'audit', batchId: '00000000-0000-0000-0000-000000000002', bus },
    );

    const reworkEvents = capturedEvents.filter((e) => e.event === 'read_only_review.rework');
    expect(reworkEvents.length).toBeGreaterThanOrEqual(1);
    expect(reworkEvents[0]).toMatchObject({
      event: 'read_only_review.rework',
      route: 'audit',
      iterationIndex: 1,
      triggeringIssues: 1,
    });
  });

  it('emits read_only_review.terminal with roundsUsed and finalQualityVerdict', async () => {
    resetCaptured();
    qualityReviewResult = 'approved';
    qualityReviewFindings = [];

    const { bus } = makeBus();
    await runTasks(
      [{ prompt: 'audit src/', agentType: 'standard', reviewPolicy: 'quality_only', cwd: '/tmp/test' }],
      config,
      { route: 'audit', batchId: '00000000-0000-0000-0000-000000000003', bus },
    );

    const terminalEvents = capturedEvents.filter((e) => e.event === 'read_only_review.terminal');
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]).toMatchObject({
      event: 'read_only_review.terminal',
      route: 'audit',
      roundsUsed: expect.any(Number) as number,
      finalQualityVerdict: 'approved',
    });
    expect(terminalEvents[0].roundsUsed).toBeGreaterThanOrEqual(1);
    expect(terminalEvents[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('emits quality event with findingsFlagged > 0 when changes_required', async () => {
    resetCaptured();
    qualityReviewResult = 'changes_required';
    qualityReviewFindings = ['deviation: incomplete analysis', 'unresolved: missing references'];

    const { bus } = makeBus();
    await runTasks(
      [{ prompt: 'audit src/', agentType: 'standard', reviewPolicy: 'quality_only', cwd: '/tmp/test' }],
      config,
      { route: 'audit', batchId: '00000000-0000-0000-0000-000000000004', bus },
    );

    const qualityEvents = capturedEvents.filter((e) => e.event === 'read_only_review.quality');
    expect(qualityEvents.length).toBeGreaterThanOrEqual(1);
    // The initial quality review with changes_required
    expect(qualityEvents[0]).toMatchObject({
      event: 'read_only_review.quality',
      route: 'audit',
      verdict: 'changes_required',
      iterationIndex: 1,
      findingsReviewed: 2,
      findingsFlagged: 2,
    });
  });

  it('emits all three event types in order for a changes_required→rework→approved lifecycle', async () => {
    resetCaptured();
    qualityReviewResult = 'changes_required';
    qualityReviewFindings = ['deviation: missing section'];

    const { bus } = makeBus();
    await runTasks(
      [{ prompt: 'audit src/', agentType: 'standard', reviewPolicy: 'quality_only', cwd: '/tmp/test' }],
      config,
      { route: 'audit', batchId: '00000000-0000-0000-0000-000000000005', bus },
    );

    const eventNames = capturedEvents.map((e) => e.event);
    const rorEvents = eventNames.filter((n) => n.startsWith('read_only_review.'));
    expect(rorEvents.length).toBeGreaterThanOrEqual(4); // quality + rework + quality + terminal

    // Order: quality → rework → quality → terminal
    const qIdx0 = rorEvents.indexOf('read_only_review.quality');
    const rwIdx = rorEvents.indexOf('read_only_review.rework');
    const qIdx1 = rorEvents.indexOf('read_only_review.quality', qIdx0 + 1);
    const tIdx = rorEvents.indexOf('read_only_review.terminal');

    expect(qIdx0).toBeLessThan(rwIdx);
    expect(rwIdx).toBeLessThan(qIdx1);
    expect(qIdx1).toBeLessThan(tIdx);
  });
});
