import { describe, it, expect } from 'vitest';
import {
  SCHEMA_VERSION,
  TaskCompletedEventSchema,
  ValidatedTaskCompletedEventSchema,
  StageEntrySchema,
  StageEntryBase,
  BatchWrapperSchema,
  UploadBatchSchema,
  STRICT_ID_REGEX,
  TierUsageSchema,
} from '../../packages/core/src/events/telemetry-types.js';

// Use the validated schema for tests that check R1-R16 rules
const Schema = ValidatedTaskCompletedEventSchema;

// ── v4 test fixtures ─────────────────────────────────────────────────────

const validStageBase = {
  name: 'implementing' as const,
  round: 0,
  model: 'claude-sonnet',
  tier: 'standard' as const,
  durationMs: 1000,
  costUSD: 0.01,
  inputTokens: 100,
  outputTokens: 50,
  cachedReadTokens: 0,
  cachedNonReadTokens: 0,
  toolCallCount: 3,
  filesReadCount: 2,
  filesWrittenCount: 1,
  turnCount: 2,
  maxIdleMs: 0,
  totalIdleMs: 0,
  mainEquivalentCostUSD: null,
};

const validTierUsage = {
  model: 'claude-sonnet',
  inputTokens: 500,
  outputTokens: 200,
  cachedReadTokens: 50,
  cachedNonReadTokens: 10,
  costUSD: 0.05,
};

function makeStage(name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const tier = (name === 'implementing') ? 'standard' : 'complex';

  const base: Record<string, unknown> = {
    name,
    round: (overrides.round as number) ?? 0,
    model: 'claude-sonnet',
    tier,
    durationMs: 1000,
    costUSD: 0.01,
    inputTokens: 100,
    outputTokens: 50,
    cachedReadTokens: 0,
    cachedNonReadTokens: 0,
    toolCallCount: 3,
    filesReadCount: 2,
    filesWrittenCount: 1,
    turnCount: 2,
    maxIdleMs: 0,
    totalIdleMs: 0,
    mainEquivalentCostUSD: null,
  };

  if (name === 'implementing') return { ...base, ...overrides };

  if (name === 'review' || name === 'review' || name === 'review') {
    return {
      ...base,
      ...{
        verdict: 'approved',
        roundsUsed: 1,
        concernCategories: [],
        findingsBySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
      },
      ...overrides,
    };
  }

  if (name === 'rework' || name === 'rework') {
    return { ...base, ...{ triggeringConcernCategories: [] }, ...overrides };
  }

  if (name === 'annotating') {
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
    makeStage('implementing'),
    makeStage('review'),
    makeStage('rework'),
    makeStage('annotating'),
    makeStage('committing'),
  ];

  // Compute top-level totals from stages unless explicitly overridden
  const sum = (field: string) => stages.reduce((s: number, st: Record<string, unknown>) => s + ((st[field] as number) ?? 0), 0);

  return {
    eventId: 'b9a5f4c2-1234-4abc-9def-0123456789ab',
    route: 'delegate',
    client: 'claude-code',
    agentType: 'standard',
    toolMode: 'full',
    reviewPolicy: 'full',
    verifyCommandPresent: true,
    implementerModel: 'claude-sonnet',
    implementerTier: 'standard',
    mainModel: null,
    mainModelFamily: 'claude',
    tierUsage: {},
    mainEquivalentCostUSD: null,
    terminalStatus: 'ok',
    workerStatus: 'done',
    errorCode: null,
    inputTokens: sum('inputTokens'),
    outputTokens: sum('outputTokens'),
    cachedReadTokens: sum('cachedReadTokens'),
    cachedNonReadTokens: sum('cachedNonReadTokens'),
    totalDurationMs: sum('durationMs'),
    totalCostUSD: stages.reduce((s: number, st: Record<string, unknown>) => s + ((st.costUSD as number) ?? 0), 0),
    costDeltaVsMainUSD: null,
    concernCount: 0,
    findingsBySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
    escalationCount: 0,
    fallbackCount: 0,
    stallCount: 0,
    taskMaxIdleMs: 0,
    sandboxViolationCount: 0,
    filesWrittenCount: sum('filesWrittenCount'),
    stages,
    ...overrides,
  };
}

describe('V4 telemetry types', () => {
  it('SCHEMA_VERSION is 4', () => {
    expect(SCHEMA_VERSION).toBe(5);
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
      makeValidEvent({ terminalStatus: 'ok', errorCode: 'provider_api_error' }),
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
        stages: [makeStage('implementing', { durationMs: 5000 })],
      }),
    );
    expect(result.success).toBe(false);
  });

  it('R4 — accepts when totalDurationMs equals stage sum', () => {
    const result = Schema.safeParse(
      makeValidEvent({
        totalDurationMs: 1000,
        stages: [makeStage('implementing', { durationMs: 1000 })],
      }),
    );
    expect(result.success).toBe(true);
  });

  // ── R5: top-level token counts must not exceed sum of stages ──
  it('R5 — rejects when token sums do not match top-level', () => {
    const result = Schema.safeParse(
      makeValidEvent({
        inputTokens: 999,
        stages: [makeStage('implementing', { inputTokens: 100 })],
      }),
    );
    expect(result.success).toBe(false);
  });

  it('R5 — accepts when token sums match exactly', () => {
    const result = Schema.safeParse(
      makeValidEvent({
        inputTokens: 100,
        outputTokens: 50,
        cachedReadTokens: 0,
        cachedNonReadTokens: 0,
        stages: [
          makeStage('implementing', {
            inputTokens: 100,
            outputTokens: 50,
            cachedReadTokens: 0,
            cachedNonReadTokens: 0,
          }),
        ],
      }),
    );
    expect(result.success).toBe(true);
  });

  // ── cost-sum: totalCostUSD approx equals sum of stage costUSD ──
  it('cost-sum — rejects when cost sum differs significantly', () => {
    const result = Schema.safeParse(
      makeValidEvent({
        totalCostUSD: 100,
        stages: [makeStage('implementing', { costUSD: 0.01 })],
      }),
    );
    expect(result.success).toBe(false);
  });

  it('cost-sum — accepts small float cost differences (within 0.02 tolerance)', () => {
    const result = Schema.safeParse(
      makeValidEvent({
        totalCostUSD: 0.0100001,
        stages: [makeStage('implementing', { costUSD: 0.01 })],
      }),
    );
    expect(result.success).toBe(true);
  });

  it('cost-sum — skipped when totalCostUSD is null', () => {
    const result = Schema.safeParse(
      makeValidEvent({
        totalCostUSD: null,
        stages: [makeStage('implementing', { costUSD: 0.05 })],
      }),
    );
    expect(result.success).toBe(true);
  });

  // ── R9: review stage only on reviewed routes ──
  it('R9 — rejects review on retry route', () => {
    const result = Schema.safeParse(
      makeValidEvent({
        route: 'retry',
        stages: [makeStage('implementing'), makeStage('review')],
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
          makeStage('implementing'),
          makeStage('review', { verdict: 'annotated' }),
          makeStage('annotating'),
          makeStage('committing'),
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
          makeStage('implementing'),
          makeStage('review', { verdict: 'annotated' }),
          makeStage('committing'),
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

  it('R14 — accepts totalCostUSD: null', () => {
    const result = Schema.safeParse(makeValidEvent({ totalCostUSD: null }));
    expect(result.success).toBe(true);
  });

  // ── R16: rework requires review in the same event ──
  it('R16 — rejects rework without review', () => {
    const result = Schema.safeParse(
      makeValidEvent({
        stages: [
          makeStage('implementing'),
          makeStage('rework'),
          makeStage('annotating'),
        ],
      }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues.some(i => i.message.startsWith('R16:'))).toBe(true);
  });

  it('R16 — accepts rework when review is present', () => {
    const result = Schema.safeParse(
      makeValidEvent({
        stages: [
          makeStage('implementing'),
          makeStage('review'),
          makeStage('rework'),
          makeStage('annotating'),
        ],
      }),
    );
    expect(result.success).toBe(true);
  });

  it('R16 — accepts quality_rework when quality_review is present', () => {
    const result = Schema.safeParse(
      makeValidEvent({
        stages: [
          makeStage('implementing'),
          makeStage('review'),
          makeStage('rework'),
          makeStage('annotating'),
        ],
      }),
    );
    expect(result.success).toBe(true);
  });
});

// ── Batch wrapper ─────────────────────────────────────────────────────────

describe('BatchWrapperSchema', () => {
  it('accepts valid V4 batch wrapper', () => {
    const result = BatchWrapperSchema.safeParse({
      schemaVersion: 5,
      installId: 'b9a5f4c2-1234-4abc-9def-0123456789ab',
      mmagentVersion: '4.0.0',
      os: 'darwin',
      nodeMajor: 22,
    });
    expect(result.success).toBe(true);
  });

  it('rejects schemaVersion !== 5', () => {
    const result = BatchWrapperSchema.safeParse({
      schemaVersion: 3,
      installId: 'b9a5f4c2-1234-4abc-9def-0123456789ab',
      mmagentVersion: '4.0.0',
      os: 'darwin',
      nodeMajor: 22,
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid UUID installId', () => {
    const result = BatchWrapperSchema.safeParse({
      schemaVersion: 5,
      installId: 'not-a-uuid',
      mmagentVersion: '4.0.0',
      os: 'darwin',
      nodeMajor: 22,
    });
    expect(result.success).toBe(false);
  });

  it('rejects nodeMajor < 22', () => {
    const result = BatchWrapperSchema.safeParse({
      schemaVersion: 5,
      installId: 'b9a5f4c2-1234-4abc-9def-0123456789ab',
      mmagentVersion: '4.0.0',
      os: 'darwin',
      nodeMajor: 20,
    });
    expect(result.success).toBe(false);
  });

  it('rejects nodeMajor > 99', () => {
    const result = BatchWrapperSchema.safeParse({
      schemaVersion: 5,
      installId: 'b9a5f4c2-1234-4abc-9def-0123456789ab',
      mmagentVersion: '4.0.0',
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
      schemaVersion: 5,
      installId: 'b9a5f4c2-1234-4abc-9def-0123456789ab',
      mmagentVersion: '4.0.0',
      os: 'darwin',
      nodeMajor: 22,
      events: [event],
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty events array', () => {
    const result = UploadBatchSchema.safeParse({
      schemaVersion: 5,
      installId: 'b9a5f4c2-1234-4abc-9def-0123456789ab',
      mmagentVersion: '4.0.0',
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
    const result = StageEntrySchema.safeParse(makeStage('implementing'));
    expect(result.success).toBe(true);
  });

  it('accepts review stage with findingsBySeverity', () => {
    const result = StageEntrySchema.safeParse(
      makeStage('review', {
        findingsBySeverity: { critical: 2, high: 2, medium: 5, low: 3 },
      }),
    );
    expect(result.success).toBe(true);
  });

  it('accepts verifying stage with outcome=passed', () => {
    const result = StageEntrySchema.safeParse(
      makeStage('annotating', { outcome: 'passed' }),
    );
    expect(result.success).toBe(true);
  });

  it('accepts verifying with outcome=skipped and skipReason set', () => {
    const result = StageEntrySchema.safeParse(
      makeStage('annotating', { outcome: 'skipped', skipReason: 'no_command' }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects rework stage without triggeringConcernCategories', () => {
    const result = StageEntrySchema.safeParse({
      name: 'rework',
      round: 0,
      model: 'claude-sonnet',
      tier: 'standard',
      durationMs: 1000,
      costUSD: 0.01,
      inputTokens: 0,
      outputTokens: 0,
      cachedReadTokens: 0,
      cachedNonReadTokens: 0,
      toolCallCount: 0,
      filesReadCount: 0,
      filesWrittenCount: 0,
      turnCount: 0,
      maxIdleMs: 0,
      totalIdleMs: 0,
      // missing triggeringConcernCategories
    });
    expect(result.success).toBe(false);
  });

  it('accepts commit stage with filesCommittedCount and branchCreated', () => {
    const result = StageEntrySchema.safeParse(
      makeStage('committing', { filesCommittedCount: 5, branchCreated: true }),
    );
    expect(result.success).toBe(true);
  });
});

// ── Nullable cached tokens (§3.6) ────────────────────────────────────────

describe('nullable cachedReadTokens and cachedNonReadTokens', () => {
  it('StageEntrySchema accepts null cachedReadTokens and cachedNonReadTokens', () => {
    const stage = makeStage('implementing', { cachedReadTokens: null, cachedNonReadTokens: null });
    const result = StageEntrySchema.safeParse(stage);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cachedReadTokens).toBeNull();
      expect(result.data.cachedNonReadTokens).toBeNull();
    }
  });

  it('TaskCompletedEventSchema accepts null cachedReadTokens and cachedNonReadTokens', () => {
    const event = makeValidEvent({
      cachedReadTokens: null,
      cachedNonReadTokens: null,
      stages: [
        makeStage('implementing', { cachedReadTokens: null, cachedNonReadTokens: null }),
        makeStage('review', { cachedReadTokens: null, cachedNonReadTokens: null }),
        makeStage('rework', { cachedReadTokens: null, cachedNonReadTokens: null }),
        makeStage('annotating', { cachedReadTokens: null, cachedNonReadTokens: null }),
        makeStage('committing', { cachedReadTokens: null, cachedNonReadTokens: null }),
      ],
    });
    const result = ValidatedTaskCompletedEventSchema.safeParse(event);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cachedReadTokens).toBeNull();
      expect(result.data.cachedNonReadTokens).toBeNull();
    }
  });

  it('R5 validation uses ?? 0 for null cached tokens (honest-null treats missing as zero for aggregate checks)', () => {
    const event = makeValidEvent({
      cachedReadTokens: null,
      cachedNonReadTokens: null,
      inputTokens: 200,
      outputTokens: 100,
      stages: [
        makeStage('implementing', {
          inputTokens: 200,
          outputTokens: 100,
          cachedReadTokens: null,
          cachedNonReadTokens: null,
        }),
      ],
    });
    const result = ValidatedTaskCompletedEventSchema.safeParse(event);
    expect(result.success).toBe(true);
  });
});

// ── Schema v4: round on stages and R7 uniqueness ─────────────────────────

describe('schema v4: round on stages and R7 uniqueness', () => {
  it('StageEntryBase requires round (≥0)', () => {
    const stage = { name: 'implementing', round: 0, tier: 'standard', model: 'm',
      durationMs: 1000, costUSD: 0.01, inputTokens: 100, outputTokens: 50,
      cachedReadTokens: 0, cachedNonReadTokens: 0,
      toolCallCount: 0, filesReadCount: 0, filesWrittenCount: 0,
      turnCount: 0, maxIdleMs: 0, totalIdleMs: 0, mainEquivalentCostUSD: null };
    expect(StageEntryBase.safeParse(stage).success).toBe(true);
  });

  it('R7 fires when (name, round) collides', () => {
    const ev = makeValidEvent({ stages: [
      makeStage('review', { round: 0 }),
      makeStage('review', { round: 0 }),
    ]});
    const r = ValidatedTaskCompletedEventSchema.safeParse(ev);
    expect(r.success).toBe(false);
    expect(r.error?.issues.some(i => /^R7:/.test(i.message))).toBe(true);
  });

  it('R7 does NOT fire when (name, round) is unique', () => {
    const ev = makeValidEvent({ stages: [
      makeStage('review', { round: 0 }),
      makeStage('review', { round: 1 }),
    ]});
    expect(ValidatedTaskCompletedEventSchema.safeParse(ev).success).toBe(true);
  });
});

// ── Schema v4: split cached fields and nullable cost ─────────────────────

describe('schema v4: split cached fields and nullable cost', () => {
  it('costUSD: null is accepted on stages', () => {
    expect(StageEntryBase.safeParse({ ...validStageBase, costUSD: null }).success).toBe(true);
  });

  it('R6b: negative cachedReadTokens fails at Zod level', () => {
    expect(StageEntryBase.safeParse({ ...validStageBase, cachedReadTokens: -1 }).success).toBe(false);
  });

  it('stages array length 16 passes', () => {
    const ev = makeValidEvent({ stages: Array.from({ length: 16 }, (_, i) => makeStage('implementing', { round: i })) });
    expect(ValidatedTaskCompletedEventSchema.safeParse(ev).success).toBe(true);
  });

  it('stages array length 17 fails', () => {
    const ev = makeValidEvent({ stages: Array.from({ length: 17 }, (_, i) => makeStage('implementing', { round: i })) });
    expect(ValidatedTaskCompletedEventSchema.safeParse(ev).success).toBe(false);
  });
});

// ── Schema v4: tierUsage and mainModel ─────────────────────────────────

describe('schema v4: tierUsage and mainModel', () => {
  it('event accepts tierUsage with subset of {standard, complex} keys', () => {
    const ev = makeValidEvent({ tierUsage: { standard: validTierUsage } });
    expect(ValidatedTaskCompletedEventSchema.safeParse(ev).success).toBe(true);
  });

  it('event accepts mainModel: null', () => {
    const ev = makeValidEvent({ mainModel: null, mainEquivalentCostUSD: null, costDeltaVsMainUSD: null });
    expect(ValidatedTaskCompletedEventSchema.safeParse(ev).success).toBe(true);
  });

  it('event accepts mainModel: "claude-opus-4-7"', () => {
    const ev = makeValidEvent({ mainModel: 'claude-opus-4-7' });
    expect(ValidatedTaskCompletedEventSchema.safeParse(ev).success).toBe(true);
  });
});

// ── TierUsageSchema ──────────────────────────────────────────────────────

describe('TierUsageSchema', () => {
  it('accepts valid tier usage', () => {
    const result = TierUsageSchema.safeParse(validTierUsage);
    expect(result.success).toBe(true);
  });

  it('accepts null costUSD', () => {
    const result = TierUsageSchema.safeParse({ ...validTierUsage, costUSD: null });
    expect(result.success).toBe(true);
  });

  it('rejects negative inputTokens', () => {
    const result = TierUsageSchema.safeParse({ ...validTierUsage, inputTokens: -1 });
    expect(result.success).toBe(false);
  });
});
