import { describe, it, expect } from 'vitest';
import {
  SCHEMA_VERSION,
  TaskCompletedEventSchema,
  ValidatedTaskCompletedEventSchema,
  StageEntrySchema,
  BatchWrapperSchema,
  UploadBatchSchema,
  STRICT_ID_REGEX,
} from '../../packages/core/src/telemetry/types.js';

// Use the validated schema for tests that check R1-R15 rules
const Schema = ValidatedTaskCompletedEventSchema;

function makeValidStage(name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base = {
    name,
    model: 'claude-sonnet',
    agentTier: 'standard',
    durationMs: 1000,
    costUSD: 0.01,
    inputTokens: 100,
    outputTokens: 50,
    cachedTokens: 0,
    reasoningTokens: 0,
    toolCallCount: 3,
    filesReadCount: 2,
    filesWrittenCount: 1,
    turnCount: 2,
    maxIdleMs: null,
    totalIdleMs: null,
  };

  if (name === 'implementing') return { ...base, ...overrides };

  if (name === 'spec_review' || name === 'quality_review' || name === 'diff_review') {
    return {
      ...base,
      ...{
        verdict: 'approved',
        roundsUsed: 1,
        concernCategories: [],
        findingsBySeverity: { high: 0, medium: 0, low: 0, style: 0 },
      },
      ...overrides,
    };
  }

  if (name === 'spec_rework' || name === 'quality_rework') {
    return { ...base, ...{ triggeringConcernCategories: [] }, ...overrides };
  }

  if (name === 'verifying') {
    return {
      ...base,
      ...{ outcome: 'passed', skipReason: null },
      ...overrides,
    };
  }

  if (name === 'committing') {
    return { ...base, ...{ filesCommittedCount: 0, branchCreated: false }, ...overrides };
  }

  return { ...base, ...overrides };
}

function makeValidEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const stages = (overrides.stages as Record<string, unknown>[]) ?? [
    makeValidStage('implementing'),
    makeValidStage('spec_review'),
    makeValidStage('quality_review'),
    makeValidStage('verifying'),
    makeValidStage('committing'),
  ];

  // Compute top-level totals from stages unless explicitly overridden
  const sum = (field: string) => stages.reduce((s: number, st: Record<string, unknown>) => s + ((st[field] as number) ?? 0), 0);

  return {
    eventId: 'b9a5f4c2-1234-4abc-9def-0123456789ab',
    route: 'delegate',
    client: 'claude-code',
    agentType: 'standard',
    toolMode: 'full',
    capabilities: ['web_search'],
    reviewPolicy: 'full',
    verifyCommandPresent: true,
    implementerModel: 'claude-sonnet',
    terminalStatus: 'ok',
    workerStatus: 'done',
    errorCode: null,
    parentModelFamily: 'claude',
    inputTokens: sum('inputTokens'),
    outputTokens: sum('outputTokens'),
    cachedTokens: sum('cachedTokens'),
    reasoningTokens: sum('reasoningTokens'),
    totalDurationMs: sum('durationMs'),
    totalCostUSD: stages.reduce((s: number, st: Record<string, unknown>) => s + ((st.costUSD as number) ?? 0), 0),
    totalSavedCostUSD: null,
    concernCount: 0,
    escalationCount: 0,
    fallbackCount: 0,
    stallCount: 0,
    taskMaxIdleMs: null,
    clarificationRequested: false,
    briefQualityWarningCount: 0,
    sandboxViolationCount: 0,
    stages,
    ...overrides,
  };
}

describe('V3 telemetry types', () => {
  it('SCHEMA_VERSION is 3', () => {
    expect(SCHEMA_VERSION).toBe(3);
  });

  it('accepts a well-formed task.completed event', () => {
    const result = Schema.safeParse(makeValidEvent());
    expect(result.success).toBe(true);
  });

  it('round-trips through JSON serialization', () => {
    const event = makeValidEvent();
    const parsed = Schema.parse(event);
    const json = JSON.stringify(parsed);
    const reParsed = Schema.parse(JSON.parse(json));
    expect(reParsed.eventId).toBe(parsed.eventId);
    expect(reParsed.totalCostUSD).toBe(parsed.totalCostUSD);
  });

  // ── R1: terminalStatus=ok requires errorCode=null and workerStatus done|done_with_concerns ──
  it('R1 — rejects ok with errorCode non-null', () => {
    const result = Schema.safeParse(
      makeValidEvent({ terminalStatus: 'ok', errorCode: 'api_error' }),
    );
    expect(result.success).toBe(false);
  });

  it('R1 — rejects ok with workerStatus=failed', () => {
    const result = Schema.safeParse(
      makeValidEvent({ terminalStatus: 'ok', workerStatus: 'failed' }),
    );
    expect(result.success).toBe(false);
  });

  it('R1 — accepts ok with workerStatus=done_with_concerns', () => {
    const result = Schema.safeParse(
      makeValidEvent({ terminalStatus: 'ok', workerStatus: 'done_with_concerns' }),
    );
    expect(result.success).toBe(true);
  });

  // ── R2.1: empty stages only for brief_too_vague and error ──
  it('R2.1 — empty stages accepted for brief_too_vague', () => {
    const result = Schema.safeParse(
      makeValidEvent({ terminalStatus: 'brief_too_vague', stages: [] }),
    );
    expect(result.success).toBe(true);
  });

  it('R2.1 — empty stages accepted for error', () => {
    const result = Schema.safeParse(
      makeValidEvent({ terminalStatus: 'error', errorCode: 'runner_crash', stages: [] }),
    );
    expect(result.success).toBe(true);
  });

  it('R2.1 — empty stages rejected for ok', () => {
    const result = Schema.safeParse(
      makeValidEvent({ terminalStatus: 'ok', stages: [] }),
    );
    expect(result.success).toBe(false);
  });

  // ── R4: totalDurationMs >= sum of stage durationMs ──
  it('R4 — rejects when stage duration sum exceeds totalDurationMs', () => {
    const result = Schema.safeParse(
      makeValidEvent({
        totalDurationMs: 100,
        stages: [makeValidStage('implementing', { durationMs: 5000 })],
      }),
    );
    expect(result.success).toBe(false);
  });

  it('R4 — accepts when totalDurationMs equals stage sum', () => {
    const result = Schema.safeParse(
      makeValidEvent({
        totalDurationMs: 1000,
        stages: [makeValidStage('implementing', { durationMs: 1000 })],
      }),
    );
    expect(result.success).toBe(true);
  });

  // ── R5: top-level token counts must equal sum of stages ──
  it('R5 — rejects when token sums do not match top-level', () => {
    const result = Schema.safeParse(
      makeValidEvent({
        inputTokens: 999,
        stages: [makeValidStage('implementing', { inputTokens: 100 })],
      }),
    );
    expect(result.success).toBe(false);
  });

  it('R5 — accepts when token sums match exactly', () => {
    const result = Schema.safeParse(
      makeValidEvent({
        inputTokens: 100,
        outputTokens: 50,
        cachedTokens: 0,
        reasoningTokens: 0,
        stages: [
          makeValidStage('implementing', {
            inputTokens: 100,
            outputTokens: 50,
            cachedTokens: 0,
            reasoningTokens: 0,
          }),
        ],
      }),
    );
    expect(result.success).toBe(true);
  });

  // ── R5b: per stage, reasoningTokens <= outputTokens ──
  it('R5b — rejects when reasoningTokens > outputTokens', () => {
    const result = Schema.safeParse(
      makeValidEvent({
        inputTokens: 200,
        outputTokens: 200,
        reasoningTokens: 100,
        stages: [
          makeValidStage('implementing', {
            inputTokens: 200,
            outputTokens: 200,
            reasoningTokens: 201, // > output
          }),
        ],
      }),
    );
    expect(result.success).toBe(false);
  });

  // ── R6: per stage, cachedTokens <= inputTokens ──
  it('R6 — rejects when cachedTokens > inputTokens', () => {
    const result = Schema.safeParse(
      makeValidEvent({
        inputTokens: 200,
        outputTokens: 50,
        cachedTokens: 300, // exceeds input
        stages: [
          makeValidStage('implementing', {
            inputTokens: 200,
            outputTokens: 50,
            cachedTokens: 300,
          }),
        ],
      }),
    );
    expect(result.success).toBe(false);
  });

  // ── R7: totalCostUSD approx equals sum of stage costUSD ──
  it('R7 — rejects when cost sum differs significantly', () => {
    const result = Schema.safeParse(
      makeValidEvent({
        totalCostUSD: 100,
        stages: [makeValidStage('implementing', { costUSD: 0.01 })],
      }),
    );
    expect(result.success).toBe(false);
  });

  it('R7 — accepts small float cost differences (within 0.02 tolerance)', () => {
    const result = Schema.safeParse(
      makeValidEvent({
        totalCostUSD: 0.0100001,
        stages: [makeValidStage('implementing', { costUSD: 0.01 })],
      }),
    );
    expect(result.success).toBe(true);
  });

  // ── R8: verifying stage only on delegate, execute-plan, verify routes ──
  it('R8 — rejects verifying on audit route', () => {
    const result = Schema.safeParse(
      makeValidEvent({
        route: 'audit',
        reviewPolicy: 'quality_only',
        stages: [
          makeValidStage('implementing'),
          makeValidStage('quality_review'),
          makeValidStage('verifying'),
        ],
      }),
    );
    expect(result.success).toBe(false);
  });

  it('R8 — accepts verifying on delegate route', () => {
    const result = Schema.safeParse(makeValidEvent({ route: 'delegate' }));
    expect(result.success).toBe(true);
  });

  // ── R9: review stages only on reviewed routes ──
  it('R9 — rejects quality_review on retry route', () => {
    const result = Schema.safeParse(
      makeValidEvent({
        route: 'retry',
        stages: [makeValidStage('implementing'), makeValidStage('quality_review')],
      }),
    );
    expect(result.success).toBe(false);
  });

  // ── R10: quality_only routes only allow quality_review ──
  it('R10 — rejects spec_review on audit (quality_only) route', () => {
    const result = Schema.safeParse(
      makeValidEvent({
        route: 'audit',
        reviewPolicy: 'quality_only',
        stages: [
          makeValidStage('implementing'),
          makeValidStage('spec_review'),
        ],
      }),
    );
    expect(result.success).toBe(false);
  });

  // ── R10b: no rework on quality_only ──
  it('R10b — rejects quality_rework on audit route', () => {
    const result = Schema.safeParse(
      makeValidEvent({
        route: 'audit',
        reviewPolicy: 'quality_only',
        stages: [
          makeValidStage('implementing'),
          makeValidStage('quality_review'),
          makeValidStage('quality_rework'),
        ],
      }),
    );
    expect(result.success).toBe(false);
  });

  // ── R10c: annotated verdict only on quality_only routes ──
  it('R10c — rejects annotated verdict on delegate (full) route', () => {
    const result = Schema.safeParse(
      makeValidEvent({
        route: 'delegate',
        reviewPolicy: 'full',
        stages: [
          makeValidStage('implementing'),
          makeValidStage('quality_review', { verdict: 'annotated' }),
          makeValidStage('verifying'),
          makeValidStage('committing'),
        ],
      }),
    );
    expect(result.success).toBe(false);
  });

  it('R10c — accepts annotated verdict on audit (quality_only) route', () => {
    const result = Schema.safeParse(
      makeValidEvent({
        route: 'audit',
        reviewPolicy: 'quality_only',
        stages: [
          makeValidStage('implementing'),
          makeValidStage('quality_review', { verdict: 'annotated' }),
          makeValidStage('committing'),
        ],
      }),
    );
    expect(result.success).toBe(true);
  });

  // ── R11-R14: schema bounds enforced by Zod ──
  it('R11 — rejects concernCount > 150', () => {
    const result = Schema.safeParse(makeValidEvent({ concernCount: 151 }));
    expect(result.success).toBe(false);
  });

  it('R12 — rejects stallCount > 20', () => {
    const result = Schema.safeParse(makeValidEvent({ stallCount: 21 }));
    expect(result.success).toBe(false);
  });

  it('R13 — rejects totalDurationMs > 86400000', () => {
    const result = Schema.safeParse(makeValidEvent({ totalDurationMs: 86_400_001 }));
    expect(result.success).toBe(false);
  });

  it('R14 — rejects totalCostUSD > 800', () => {
    const result = Schema.safeParse(makeValidEvent({ totalCostUSD: 801 }));
    expect(result.success).toBe(false);
  });

  it('R15 — rejects stage costUSD > 100', () => {
    const result = Schema.safeParse(
      makeValidEvent({
        totalCostUSD: 100,
        stages: [makeValidStage('implementing', { costUSD: 101 })],
      }),
    );
    expect(result.success).toBe(false);
  });
});

// ── Batch wrapper ─────────────────────────────────────────────────────────

describe('BatchWrapperSchema', () => {
  it('accepts valid V3 batch wrapper', () => {
    const result = BatchWrapperSchema.safeParse({
      schemaVersion: 3,
      installId: 'b9a5f4c2-1234-4abc-9def-0123456789ab',
      mmagentVersion: '3.10.0',
      os: 'darwin',
      nodeMajor: 22,
    });
    expect(result.success).toBe(true);
  });

  it('rejects schemaVersion !== 3', () => {
    const result = BatchWrapperSchema.safeParse({
      schemaVersion: 2,
      installId: 'b9a5f4c2-1234-4abc-9def-0123456789ab',
      mmagentVersion: '3.10.0',
      os: 'darwin',
      nodeMajor: 22,
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid UUID installId', () => {
    const result = BatchWrapperSchema.safeParse({
      schemaVersion: 3,
      installId: 'not-a-uuid',
      mmagentVersion: '3.10.0',
      os: 'darwin',
      nodeMajor: 22,
    });
    expect(result.success).toBe(false);
  });

  it('rejects nodeMajor < 22', () => {
    const result = BatchWrapperSchema.safeParse({
      schemaVersion: 3,
      installId: 'b9a5f4c2-1234-4abc-9def-0123456789ab',
      mmagentVersion: '3.10.0',
      os: 'darwin',
      nodeMajor: 20,
    });
    expect(result.success).toBe(false);
  });

  it('rejects nodeMajor > 99', () => {
    const result = BatchWrapperSchema.safeParse({
      schemaVersion: 3,
      installId: 'b9a5f4c2-1234-4abc-9def-0123456789ab',
      mmagentVersion: '3.10.0',
      os: 'darwin',
      nodeMajor: 100,
    });
    expect(result.success).toBe(false);
  });
});

// ── Upload batch ──────────────────────────────────────────────────────────

describe('UploadBatchSchema', () => {
  it('accepts a valid upload batch', () => {
    const event = Schema.parse(makeValidEvent());
    const result = UploadBatchSchema.safeParse({
      schemaVersion: 3,
      installId: 'b9a5f4c2-1234-4abc-9def-0123456789ab',
      mmagentVersion: '3.10.0',
      os: 'darwin',
      nodeMajor: 22,
      events: [event],
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty events array', () => {
    const result = UploadBatchSchema.safeParse({
      schemaVersion: 3,
      installId: 'b9a5f4c2-1234-4abc-9def-0123456789ab',
      mmagentVersion: '3.10.0',
      os: 'darwin',
      nodeMajor: 22,
      events: [],
    });
    expect(result.success).toBe(false);
  });
});

// ── STRICT_ID_REGEX ───────────────────────────────────────────────────────

describe('STRICT_ID_REGEX', () => {
  it.each([
    'claude-sonnet-4-6',
    'gpt-5.5',
    'claude-haiku-4-5',
    'deepseek-v4-pro',
    'meta-llama/llama-4',
    'claude-sonnet-4-6@2024-10-22',
    'MiniMax-M2.7',
    'custom-model-v3',
    'a'.repeat(120),
  ])('accepts valid model ID: %s', (id) => {
    expect(STRICT_ID_REGEX.test(id)).toBe(true);
  });

  it.each([
    '',
    'model with spaces',
    'モデル',
    'a'.repeat(121),
    '<script>alert("xss")</script>',
  ])('rejects invalid ID: %s', (id) => {
    expect(STRICT_ID_REGEX.test(id)).toBe(false);
  });
});

// ── StageEntry discriminated union ────────────────────────────────────────

describe('StageEntrySchema', () => {
  it('accepts implementing stage', () => {
    const result = StageEntrySchema.safeParse(makeValidStage('implementing'));
    expect(result.success).toBe(true);
  });

  it('accepts review stage with findingsBySeverity', () => {
    const result = StageEntrySchema.safeParse(
      makeValidStage('quality_review', {
        findingsBySeverity: { high: 2, medium: 5, low: 3, style: 1 },
      }),
    );
    expect(result.success).toBe(true);
  });

  it('accepts verifying stage with outcome=passed', () => {
    const result = StageEntrySchema.safeParse(
      makeValidStage('verifying', { outcome: 'passed' }),
    );
    expect(result.success).toBe(true);
  });

  it('accepts verifying with outcome=skipped and skipReason set', () => {
    const result = StageEntrySchema.safeParse(
      makeValidStage('verifying', { outcome: 'skipped', skipReason: 'no_command' }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects rework stage without triggeringConcernCategories', () => {
    const result = StageEntrySchema.safeParse({
      name: 'quality_rework',
      model: 'claude-sonnet',
      agentTier: 'standard',
      durationMs: 1000,
      costUSD: 0.01,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      reasoningTokens: 0,
      toolCallCount: 0,
      filesReadCount: 0,
      filesWrittenCount: 0,
      turnCount: 0,
      maxIdleMs: null,
      totalIdleMs: null,
      // missing triggeringConcernCategories
    });
    expect(result.success).toBe(false);
  });

  it('accepts commit stage with filesCommittedCount and branchCreated', () => {
    const result = StageEntrySchema.safeParse(
      makeValidStage('committing', { filesCommittedCount: 5, branchCreated: true }),
    );
    expect(result.success).toBe(true);
  });
});
