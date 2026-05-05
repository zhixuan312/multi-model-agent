import { describe, it, expect, vi } from 'vitest';
import type { MultiModelConfig } from '@zhixuan92/multi-model-agent-core';

import { EventEmitter } from '../../packages/core/src/events/event-emitter.js';
import type { EventType, EventSink } from '../../packages/core/src/events/event-emitter.js';
import { ReadOnlyReviewQualityEvent } from '../../packages/core/src/events/observability-events.js';

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

const VALID_EVIDENCE = 'The function silently swallows errors and returns null — this is the issue and it needs a guard added at the top.';

// Worker output as a narrative report — the runtime feeds this to the
// implementer mock, and the annotation-path reviewer extracts findings from it.
const NARRATIVE_WORKER_OUTPUT = [
  '# Audit Report',
  '### 1. Silent error swallowing in parseConfig',
  'Severity: high',
  'Location: src/auth/login.ts:89',
  'The function silently swallows errors and returns null — this is the issue and it needs a guard added at the top.',
  '',
  '### 2. Unguarded property access',
  'Severity: medium',
  'Location: src/auth/login.ts:100',
  'The property access is unguarded against undefined req.body.user and will throw in production.',
].join('\n');

const REVIEWER_OUTPUT = [
  '```json',
  JSON.stringify([
    { id: 'F1', severity: 'high', claim: 'silent error swallowing', evidence: 'The function silently swallows errors and returns null — this is the issue and it needs a guard added at the top.', annotatorConfidence: 80 },
    { id: 'F2', severity: 'medium', claim: 'unguarded property access', evidence: 'The property access is unguarded against undefined req.body.user and will throw in production.', annotatorConfidence: 40 },
  ]),
  '```',
].join('\n');

const reviewerOutputState = vi.hoisted(() => ({
  output: '',
}));
reviewerOutputState.output = REVIEWER_OUTPUT;

vi.mock('@zhixuan92/multi-model-agent-core/providers/provider-factory', () => ({
  createProvider: (slot: string) => ({
    name: slot,
    config: { type: 'openai-compatible' as const, model: `${slot}-model`, baseUrl: 'https://ex.invalid/v1' },
    run: vi.fn(async (prompt: string) => {
      // The reviewer prompts include the rubric "annotatorConfidence"
      const isReviewer = typeof prompt === 'string' && prompt.includes('annotatorConfidence');
      if (isReviewer) {
        return {
          output: reviewerOutputState.output,
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
        output: NARRATIVE_WORKER_OUTPUT,
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

import { runTasks } from '@zhixuan92/multi-model-agent-core/lifecycle/run-tasks';

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

function makeBus(): { bus: EventEmitter; sink: CaptureSink } {
  const sink = new CaptureSink();
  const bus = new EventEmitter([sink]);
  return { bus, sink };
}

describe('read-only review telemetry (annotation model, 3.8.1)', () => {
  it('emits read_only_review.quality with verdict=annotated and annotation summary fields', async () => {
    reviewerOutputState.output = REVIEWER_OUTPUT;
    resetCaptured();

    const { bus } = makeBus();
    const [result] = await runTasks(
      [{ prompt: 'audit src/', agentType: 'standard', reviewPolicy: 'quality_only', cwd: '/tmp/test' }],
      config,
      { route: 'audit', batchId: '12345678-1234-4234-8234-000000000001', bus, qualityReviewPromptBuilder: buildAuditQualityPrompt },
    );

    expect(result.status).toBe('ok');

    // Annotated findings populated on the RunResult
    expect(result.annotatedFindings).toBeDefined();
    expect(result.annotatedFindings!.length).toBeGreaterThanOrEqual(1);
    expect(result.annotatedFindings![0]!.severity).toBe('high');
    expect(result.annotatedFindings![0]!.annotatorConfidence).toBe(80);
    expect(result.annotatedFindings![0]!.evidenceGrounded).toBe(true);

    const qualityEvents = capturedEvents.filter((e) => e.event === 'read_only_review.quality');
    expect(qualityEvents).toHaveLength(1);
    expect(qualityEvents[0]).toMatchObject({
      event: 'read_only_review.quality',
      route: 'audit',
      verdict: 'annotated',
      iterationIndex: 1,
      findingsReviewed: 2,
      // meanConfidence: (80 + 40) / 2 = 60
      meanConfidence: 60,
    });
  });

  it('does NOT emit read_only_review.rework anymore (rework loop deleted in 3.8.1)', async () => {
    reviewerOutputState.output = REVIEWER_OUTPUT;
    resetCaptured();

    const { bus } = makeBus();
    await runTasks(
      [{ prompt: 'audit src/', agentType: 'standard', reviewPolicy: 'quality_only', cwd: '/tmp/test' }],
      config,
      { route: 'audit', batchId: '12345678-1234-4234-8234-000000000002', bus, qualityReviewPromptBuilder: buildAuditQualityPrompt },
    );

    const reworkEvents = capturedEvents.filter((e) => e.event === 'read_only_review.rework');
    expect(reworkEvents).toHaveLength(0);
  });

  it('emits read_only_review.terminal with roundsUsed=1 and finalQualityVerdict=annotated', async () => {
    reviewerOutputState.output = REVIEWER_OUTPUT;
    resetCaptured();

    const { bus } = makeBus();
    await runTasks(
      [{ prompt: 'audit src/', agentType: 'standard', reviewPolicy: 'quality_only', cwd: '/tmp/test' }],
      config,
      { route: 'audit', batchId: '12345678-1234-4234-8234-000000000003', bus, qualityReviewPromptBuilder: buildAuditQualityPrompt },
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
    reviewerOutputState.output = REVIEWER_OUTPUT;
    resetCaptured();

    const { bus } = makeBus();
    await runTasks(
      [{ prompt: 'audit src/', agentType: 'standard', reviewPolicy: 'quality_only', cwd: '/tmp/test' }],
      config,
      { route: 'audit', batchId: '12345678-1234-4234-8234-000000000004', bus, qualityReviewPromptBuilder: buildAuditQualityPrompt },
    );

    const rorEventNames = capturedEvents
      .map((e) => e.event)
      .filter((n) => n.startsWith('read_only_review.'));

    expect(rorEventNames).toEqual(['read_only_review.quality', 'read_only_review.terminal']);
  });

  it('emits meanConfidence=null when deterministic fallback annotates every finding', async () => {
    reviewerOutputState.output = 'not parseable as reviewer JSON';
    resetCaptured();

    const { bus } = makeBus();
    const [result] = await runTasks(
      [{ prompt: 'audit src/', agentType: 'standard', reviewPolicy: 'quality_only', cwd: '/tmp/test' }],
      config,
      { route: 'audit', batchId: '12345678-1234-4234-8234-000000000005', bus, qualityReviewPromptBuilder: buildAuditQualityPrompt },
    );

    expect(result.status).toBe('ok');
    expect(result.annotatedFindings).toBeDefined();
    expect(result.annotatedFindings!.length).toBeGreaterThanOrEqual(1);
    expect(result.annotatedFindings!.every((f) => f.annotatorConfidence === null)).toBe(true);

    const qualityEvents = capturedEvents.filter((e) => e.event === 'read_only_review.quality');
    expect(qualityEvents).toHaveLength(1);
    expect(qualityEvents[0]).toMatchObject({
      event: 'read_only_review.quality',
      route: 'audit',
      verdict: 'annotated',
      meanConfidence: null,
    });
  });
});

describe('read_only_review.quality event has no findingsFlagged or severityCorrections', () => {
  it('does not emit findingsFlagged or severityCorrections (dead fields removed per §3.10)', async () => {
    reviewerOutputState.output = REVIEWER_OUTPUT;
    resetCaptured();

    const { bus } = makeBus();
    await runTasks(
      [{ prompt: 'audit src/', agentType: 'standard', reviewPolicy: 'quality_only', cwd: '/tmp/test' }],
      config,
      { route: 'audit', batchId: '12345678-1234-4234-8234-000000000006', bus, qualityReviewPromptBuilder: buildAuditQualityPrompt },
    );

    const qualityEvents = capturedEvents.filter((e) => e.event === 'read_only_review.quality');
    expect(qualityEvents).toHaveLength(1);
    expect(qualityEvents[0]).not.toHaveProperty('findingsFlagged');
    expect(qualityEvents[0]).not.toHaveProperty('severityCorrections');
  });
});

describe('ReadOnlyReviewQualityEvent — null meanConfidence', () => {
  it('accepts meanConfidence=null (all-fallback path)', () => {
    const sample = {
      // TaskBase fields
      ts: '2026-05-01T12:00:00.000+00:00',
      batchId: '550e8400-e29b-41d4-a716-446655440001',
      taskIndex: 0,
      // Per-event fields
      event: 'read_only_review.quality' as const,
      route: 'audit',
      verdict: 'annotated' as const,
      iterationIndex: 1,
      findingsReviewed: 2,
      meanConfidence: null,
      durationMs: 1234,
      costUSD: 0.05,
    };
    const result = ReadOnlyReviewQualityEvent.safeParse(sample);
    expect(result.success).toBe(true);
    if (!result.success) throw new Error(`schema rejected null meanConfidence: ${result.error.message}`);
  });
});

describe('ReadOnlyReviewQualityEvent — rejects dead fields (§3.10)', () => {
  const validSample = {
    ts: '2026-05-01T12:00:00.000+00:00',
    batchId: '550e8400-e29b-41d4-a716-446655440001',
    taskIndex: 0,
    event: 'read_only_review.quality' as const,
    route: 'audit',
    verdict: 'annotated' as const,
    iterationIndex: 1,
    findingsReviewed: 2,
    meanConfidence: 80,
    durationMs: 1234,
    costUSD: 0.05,
  };

  it('rejects payload with findingsFlagged (dead field)', () => {
    const result = ReadOnlyReviewQualityEvent.safeParse({
      ...validSample,
      findingsFlagged: 0,
    });
    expect(result.success).toBe(false);
  });

  it('rejects payload with severityCorrections (dead field)', () => {
    const result = ReadOnlyReviewQualityEvent.safeParse({
      ...validSample,
      severityCorrections: 0,
    });
    expect(result.success).toBe(false);
  });
});
