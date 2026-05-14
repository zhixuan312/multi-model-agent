import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createRecorder,
  collectValidationWarnings,
} from '../../packages/server/src/telemetry/recorder.js';
import { buildTaskCompletedEvent } from '../../packages/core/src/events/event-builder.js';
import type { BuildContext } from '../../packages/core/src/events/event-builder.js';
import {
  TaskCompletedEventSchema,
  UploadBatchSchema,
  type TaskCompletedEventType,
} from '../../packages/core/src/events/telemetry-types.js';

// ── Helpers ──────────────────────────────────────────────────────────────

const TEST_DIRS: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mma-test-warnings-'));
  TEST_DIRS.push(dir);
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ telemetry: { enabled: true } }));
  return dir;
}

async function waitForQueuedRecord(dir: string): Promise<any> {
  const queuePath = join(dir, 'telemetry-queue.ndjson');
  for (let i = 0; i < 50; i++) {
    if (existsSync(queuePath)) {
      const lines = readFileSync(queuePath, 'utf8').split('\n').filter(Boolean);
      if (lines.length > 0) return JSON.parse(lines[lines.length - 1]);
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for telemetry queue record');
}

afterEach(() => {
  for (const dir of TEST_DIRS.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

/**
 * Minimal valid event where top-level token counts do not exceed
 * the sum of stage token counts (R5 invariant is satisfied).
 */
function makeMinimalValidEvent(): TaskCompletedEventType {
  return {
    eventId: '11111111-1111-4111-8111-111111111111',
    route: 'delegate',
    client: 'test-client',
    agentType: 'standard',
    toolMode: 'full',
    reviewPolicy: 'full',
    verifyCommandPresent: false,
    implementerModel: 'gpt-5',
    implementerTier: 'standard',
    terminalStatus: 'ok',
    workerStatus: 'done',
    errorCode: null,
    mainModel: null,
    mainModelFamily: 'openai',
    tierUsage: {},
    inputTokens: 600,
    outputTokens: 150,
    cachedReadTokens: 60,
    cachedNonReadTokens: 0,
    totalDurationMs: 50000,
    totalCostUSD: 0.031,
    mainEquivalentCostUSD: null,
    costDeltaVsMainUSD: null,
    concernCount: 0,
    findingsBySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
    escalationCount: 0,
    fallbackCount: 0,
    stallCount: 0,
    taskMaxIdleMs: 5000,
    sandboxViolationCount: 0,
    filesWrittenCount: 2, // two stages: implementing(1) + committing(1)
    stages: [
      {
        name: 'implementing',
        round: 0,
        model: 'gpt-5',
        tier: 'standard',
        durationMs: 30000,
        costUSD: 0.03,
        inputTokens: 500,
        outputTokens: 100,
        cachedReadTokens: 50,
        cachedNonReadTokens: 0,
        toolCallCount: 4,
        filesReadCount: 2,
        filesWrittenCount: 1,
        turnCount: 7,
        maxIdleMs: 1000,
        totalIdleMs: 5000,
        mainEquivalentCostUSD: null,
      },
      {
        name: 'committing',
        round: 0,
        model: 'gpt-5',
        tier: 'standard',
        durationMs: 500,
        costUSD: 0.001,
        inputTokens: 100,
        outputTokens: 50,
        cachedReadTokens: 10,
        cachedNonReadTokens: 0,
        toolCallCount: 1,
        filesReadCount: 1,
        filesWrittenCount: 1,
        turnCount: 1,
        maxIdleMs: 50,
        totalIdleMs: 100,
        mainEquivalentCostUSD: null,
        filesCommittedCount: 1,
        branchCreated: false,
      },
    ],
  };
}

function makeHealthyContext(): BuildContext {
  return {
    route: 'delegate',
    taskSpec: { filePaths: [] },
    realFilesChanged: [],
    runResult: {
      status: 'ok',
      durationMs: 50000,
      workerStatus: 'done',
      usage: { inputTokens: 600, outputTokens: 150, cachedReadTokens: 0, cachedNonReadTokens: 0 },
      models: { implementer: 'gpt-5', specReviewer: 'claude-sonnet', qualityReviewer: 'claude-sonnet' },
      agents: {
        implementer: 'standard' as const,
        implementerToolMode: 'full' as const,
      },
      stageStats: {
        implementing: {
          stage: 'implementing', entered: true, durationMs: 30000, costUSD: 0.03,
          agentTier: 'standard', modelFamily: 'openai', model: 'gpt-5',
          maxIdleMs: 1000, totalIdleMs: 5000, activityEvents: 20,
          inputTokens: 500, outputTokens: 100, cachedTokens: 50,
          reasoningTokens: 25, turnCount: 7, toolCallCount: 4,
          filesReadCount: 2, filesWrittenCount: 1,
        } as any,
        committing: {
          stage: 'committing', entered: true, durationMs: 500, costUSD: 0.001,
          agentTier: 'standard', modelFamily: 'openai', model: 'gpt-5',
          maxIdleMs: 50, totalIdleMs: 100, activityEvents: 1,
          inputTokens: 100, outputTokens: 50, cachedTokens: 10,
          reasoningTokens: 5, turnCount: 1, toolCallCount: 1,
          filesReadCount: 1, filesWrittenCount: 1,
        } as any,
      },
      terminationReason: {
        cause: 'finished' as const,
        turnsUsed: 14,
        hasFileArtifacts: true,
        usedShell: false,
        workerSelfAssessment: 'done' as const,
        wasPromoted: false,
      },
      commits: [],
      concerns: [],
      escalationLog: [],
    } as any,
    client: 'test',
    mainModel: null,
  };
}

// ── Unit tests: collectValidationWarnings ────────────────────────────────

describe('collectValidationWarnings', () => {
  it('returns empty arrays for a healthy event', () => {
    const event = makeMinimalValidEvent();
    const result = collectValidationWarnings(event);

    expect(result.warnings).toEqual([]);
    expect(result.baseIssues).toEqual([]);
    expect(result.refinedIssues).toEqual([]);
  });

  it('captures base-schema validation warnings for structurally invalid events', () => {
    // Route is not a valid enum value — fails base schema parse
    const event = { ...makeMinimalValidEvent(), route: 'bogus-route' as any };
    const result = collectValidationWarnings(event);

    expect(result.baseIssues.length).toBeGreaterThan(0);
    expect(result.baseIssues.some(i => i.path === 'route')).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    // The same issue appears in both base and refined parse; dedup
    // should keep exactly one entry per (message, path) key.
    const routeWarnings = result.warnings.filter(w => w.path === 'route');
    expect(routeWarnings.length).toBe(1);
  });

  it('captures cross-field (refined-only) validation warnings', () => {
    // R1 violation: terminalStatus=ok with workerStatus=blocked
    const event = {
      ...makeMinimalValidEvent(),
      workerStatus: 'blocked' as const,
    };
    const result = collectValidationWarnings(event);

    expect(result.baseIssues).toEqual([]);
    expect(result.refinedIssues.length).toBeGreaterThan(0);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some(w => w.rule.startsWith('R1:'))).toBe(true);
  });

  it('deduplicates issues appearing in both base and refined parse', () => {
    // An event whose base-schema issue (invalid enum value for route)
    // also surfaces in the refined parse. Because ValidatedTaskCompletedEventSchema
    // extends TaskCompletedEventSchema, the base-schema errors appear in
    // both parse results. Dedup by (message, path) key ensures one entry.
    const event = {
      ...makeMinimalValidEvent(),
      route: 'bogus-route' as any,
    };
    const result = collectValidationWarnings(event);

    // Each issue from the base parse should appear exactly once in warnings
    for (const bi of result.baseIssues) {
      const matches = result.warnings.filter(
        w => w.rule === bi.message && w.path === bi.path,
      );
      expect(matches.length).toBe(1);
    }
  });

  it('reports empty string path for cross-field issues', () => {
    // Zod's superRefine addIssue produces path [] which joins to ''
    const event = {
      ...makeMinimalValidEvent(),
      workerStatus: 'blocked' as const,
    };
    const result = collectValidationWarnings(event);

    const crossFieldWarnings = result.warnings.filter(
      w => w.rule.startsWith('R1:'),
    );
    expect(crossFieldWarnings.length).toBeGreaterThan(0);
    for (const w of crossFieldWarnings) {
      expect(w.path).toBe('');
    }
  });

  it('produces enriched events that still pass TaskCompletedEventSchema', () => {
    // An event with validation_warnings attached should still parse
    // successfully because validation_warnings is an optional field.
    const event = {
      ...makeMinimalValidEvent(),
      workerStatus: 'blocked' as const,
    };
    const { warnings } = collectValidationWarnings(event);
    expect(warnings.length).toBeGreaterThan(0);

    const enriched = { ...event, validation_warnings: warnings };
    const parsed = TaskCompletedEventSchema.safeParse(enriched);
    expect(parsed.success).toBe(true);
  });

  it('handles events with both base-schema and cross-field issues', () => {
    // An event that passes base schema but violates cross-field rules.
    // Skip the base-schema issue here (invalid route would prevent
    // superRefine from running). Instead test multiple cross-field
    // violations in one event.
    const event = {
      ...makeMinimalValidEvent(),
      workerStatus: 'blocked' as const,          // R1 violation
      totalDurationMs: 10,                       // R4: sum stage durations (30500) > total (10)
      implementerModel: 'claude-sonnet',         // R3: review stages must use diff model
    };
    // Fix R3 by making review stages use a different model
    event.stages = event.stages.filter(s => s.name === 'implementing');

    const result = collectValidationWarnings(event);

    expect(result.baseIssues).toEqual([]);
    expect(result.refinedIssues.length).toBeGreaterThanOrEqual(2);
    expect(result.warnings.length).toBeGreaterThanOrEqual(2);
    expect(result.warnings.some(w => w.rule.startsWith('R1:'))).toBe(true);
    expect(result.warnings.some(w => w.rule.startsWith('R4:'))).toBe(true);
    // Dedup: each issue appears once
    const r1Warnings = result.warnings.filter(w => w.rule.startsWith('R1:'));
    expect(r1Warnings.length).toBe(1);
  });
});

// ── R6b: soft warning for cached grossly exceeding input ─────────────────

describe('R6b soft warning: cached >> input', () => {
  it('emits validation_warning when cachedReadTokens + cachedNonReadTokens > 100 × inputTokens', () => {
    const event = makeMinimalValidEvent();
    event.stages[0].inputTokens = 100;
    event.stages[0].cachedReadTokens = 11_000;
    event.stages[0].cachedNonReadTokens = 0;
    event.stages[0].outputTokens = 50;

    const result = collectValidationWarnings(event);

    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule: 'R6b', path: 'stages[0]' }),
      ]),
    );
  });

  it('triggers when cachedNonReadTokens alone exceed threshold', () => {
    const event = makeMinimalValidEvent();
    event.stages[0].inputTokens = 100;
    event.stages[0].cachedReadTokens = 0;
    event.stages[0].cachedNonReadTokens = 15_000;
    event.stages[0].outputTokens = 50;

    const result = collectValidationWarnings(event);
    expect(result.warnings.some(w => w.rule === 'R6b' && w.path === 'stages[0]')).toBe(true);
  });

  it('triggers when sum of both cached fields exceeds threshold', () => {
    const event = makeMinimalValidEvent();
    event.stages[0].inputTokens = 100;
    event.stages[0].cachedReadTokens = 6_000;
    event.stages[0].cachedNonReadTokens = 5_000;
    event.stages[0].outputTokens = 50;

    const result = collectValidationWarnings(event);
    expect(result.warnings.some(w => w.rule === 'R6b' && w.path === 'stages[0]')).toBe(true);
  });

  it('no warning when cached ratio is normal', () => {
    const event = makeMinimalValidEvent();
    event.stages[0].inputTokens = 500;
    event.stages[0].cachedReadTokens = 5_000;
    event.stages[0].cachedNonReadTokens = 0;

    const result = collectValidationWarnings(event);
    expect(result.warnings.filter(w => w.rule === 'R6b')).toEqual([]);
  });

  it('no warning when inputTokens is 0 (division guard)', () => {
    const event = makeMinimalValidEvent();
    event.stages[0].inputTokens = 0;
    event.stages[0].cachedReadTokens = 50_000;
    event.stages[0].cachedNonReadTokens = 50_000;

    const result = collectValidationWarnings(event);
    expect(result.warnings.filter(w => w.rule === 'R6b')).toEqual([]);
  });

  it('detects R6b across multiple stages', () => {
    const event = makeMinimalValidEvent();
    event.stages[0].inputTokens = 100;
    event.stages[0].cachedReadTokens = 11_000;
    event.stages[0].cachedNonReadTokens = 0;
    event.stages[1].inputTokens = 10;
    event.stages[1].cachedReadTokens = 0;
    event.stages[1].cachedNonReadTokens = 2_000;

    const result = collectValidationWarnings(event);
    const r6bWarnings = result.warnings.filter(w => w.rule === 'R6b');
    expect(r6bWarnings).toHaveLength(2);
    expect(r6bWarnings.map(w => w.path).sort()).toEqual(['stages[0]', 'stages[1]']);
  });
});

// ── Integration tests: recorder end-to-end ──────────────────────────────

describe('Item 13: validation_warnings attached to event (recorder integration)', () => {
  it('R1 violation event ships with validation_warnings populated', async () => {
    const dir = makeTempDir();
    const recorder = createRecorder({ homeDir: dir, mmagentVersion: '0.0.0-test' });

    const ctx = makeHealthyContext();
    (ctx.runResult.terminationReason as any).workerSelfAssessment = 'blocked';

    recorder.recordTaskCompleted(ctx);

    const queuedBatch = await waitForQueuedRecord(dir);
    const parsedBatch = UploadBatchSchema.safeParse(queuedBatch);
    expect(parsedBatch.success).toBe(true);

    const enqueued = queuedBatch.events[0];
    expect(enqueued.validation_warnings).toBeDefined();
    expect(enqueued.validation_warnings.some((w: any) => w.rule.startsWith('R1:'))).toBe(true);
  });

  it('healthy event is enqueued without validation_warnings', async () => {
    const dir = makeTempDir();
    const recorder = createRecorder({ homeDir: dir, mmagentVersion: '0.0.0-test' });

    const ctx = makeHealthyContext();

    recorder.recordTaskCompleted(ctx);

    const queuedBatch = await waitForQueuedRecord(dir);
    const parsedBatch = UploadBatchSchema.safeParse(queuedBatch);
    expect(parsedBatch.success).toBe(true);

    const enqueued = queuedBatch.events[0];
    expect(enqueued.validation_warnings).toBeUndefined();
  });

  it('base-schema-invalid event is enqueued with validation_warnings', async () => {
    const dir = makeTempDir();
    const recorder = createRecorder({ homeDir: dir, mmagentVersion: '0.0.0-test' });

    const ctx = makeHealthyContext();
    ctx.client = 'invalid client with spaces';

    recorder.recordTaskCompleted(ctx);

    const queuedBatch = await waitForQueuedRecord(dir);
    const enqueued = queuedBatch.events[0];
    expect(enqueued.validation_warnings).toBeDefined();
    expect(enqueued.validation_warnings.some((w: any) => w.path === 'client')).toBe(true);
  });
});
