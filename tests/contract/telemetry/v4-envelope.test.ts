import { describe, it, expect } from 'vitest';
import { ValidatedTaskCompletedEventSchema, UploadBatchSchema } from '../../../packages/core/src/events/telemetry-types.js';

function makeStage(name: string, overrides: Record<string, unknown> = {}) {
  // R3: review stages must use a different tier than implementerTier.
  const tier = name === 'implementing' ? 'standard' : 'complex';

  const base: Record<string, unknown> = {
    name,
    model: 'claude-sonnet',
    tier,
    round: 0,
    durationMs: 5000,
    costUSD: 0.01,
    inputTokens: 100,
    outputTokens: 80,
    cachedReadTokens: 0,
    cachedNonReadTokens: 0,
    toolCallCount: 5,
    filesReadCount: 3,
    filesWrittenCount: 1,
    turnCount: 3,
    maxIdleMs: 0,
    totalIdleMs: 0,
    mainEquivalentCostUSD: null,
  };

  switch (name) {
    case 'implementing':
      return { ...base, ...overrides, name } as const;
    case 'committing':
      return {
        ...base,
        filesCommittedCount: 0,
        branchCreated: false,
        ...overrides,
        name,
      } as const;
    case 'review':
    case 'review':
    case 'review':
      return {
        ...base,
        verdict: 'approved' as const,
        roundsUsed: 1,
        concernCategories: [] as string[],
        findingsBySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
        ...overrides,
        name,
      } as const;
    case 'rework':
    case 'rework':
      return {
        ...base,
        triggeringConcernCategories: [] as string[],
        ...overrides,
        name,
      } as const;
    case 'annotating':
      return {
        ...base,
        outcome: 'passed' as const,
        skipReason: null,
        ...overrides,
        name,
      } as const;
    default:
      return { ...base, ...overrides, name } as const;
  }
}

function makeEvent(route: string, overrides: Record<string, unknown> = {}) {
  const stages = (overrides.stages as Record<string, unknown>[]) ?? getDefaultStages(route);
  const sum = (field: string) => stages.reduce((s, st) => s + ((st[field] as number) ?? 0), 0);

  return {
    eventId: 'e1e1e1e1-1111-4aaa-9999-111111111111',
    route,
    client: 'claude-code',
    agentType: 'standard' as const,
    toolMode: 'full' as const,
    reviewPolicy: route === 'delegate' ? 'full' as const : 'quality_only' as const,
    verifyCommandPresent: route === 'delegate' || route === 'execute-plan',
    implementerModel: 'claude-sonnet',
    implementerTier: 'standard' as const,
    terminalStatus: 'ok' as const,
    workerStatus: 'done' as const,
    errorCode: null,
    mainModel: null,
    mainModelFamily: 'claude' as const,
    tierUsage: {},
    inputTokens: sum('inputTokens'),
    outputTokens: sum('outputTokens'),
    cachedReadTokens: sum('cachedReadTokens'),
    cachedNonReadTokens: sum('cachedNonReadTokens'),
    totalDurationMs: sum('durationMs'),
    totalCostUSD: stages.reduce((s, st) => s + ((st.costUSD as number) ?? 0), 0),
    mainEquivalentCostUSD: null,
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

function getDefaultStages(route: string) {
  const stages = [makeStage('implementing')];

  if (route === 'delegate' || route === 'execute-plan') {
    stages.push(makeStage('review'));
    stages.push(makeStage('rework'));
    stages.push(makeStage('annotating'));
  } else if (['audit', 'review', 'debug', 'investigate'].includes(route)) {
    stages.push(makeStage('review', { verdict: 'annotated' }));
  }

  stages.push(makeStage('committing'));
  return stages;
}

describe('V4 envelope contract', () => {
  it('delegate happy path (full review, 5 stages)', () => {
    const event = makeEvent('delegate');
    const parsed = ValidatedTaskCompletedEventSchema.parse(event);
    expect(parsed.stages).toHaveLength(5);
    expect(parsed.route).toBe('delegate');
    expect(parsed.terminalStatus).toBe('ok');
  });

  it('delegate no rework (review approved round 1)', () => {
    const event = makeEvent('delegate', {
      stages: [
        makeStage('implementing'),
        makeStage('review', { verdict: 'approved', roundsUsed: 1 }),
        makeStage('annotating', { outcome: 'passed' }),
        makeStage('committing'),
      ],
    });
    const parsed = ValidatedTaskCompletedEventSchema.parse(event);
    expect(parsed.stages).toHaveLength(4);
  });

  it('audit happy path (quality_only, annotated verdict)', () => {
    const event = makeEvent('audit');
    const parsed = ValidatedTaskCompletedEventSchema.parse(event);
    expect(parsed.route).toBe('audit');
    const qr = parsed.stages.find(s => s.name === 'review');
    expect(qr).toBeDefined();
    if (qr && 'verdict' in qr) expect(qr.verdict).toBe('annotated');
  });

  it('review happy path (quality_only default)', () => {
    const event = makeEvent('review');
    const parsed = ValidatedTaskCompletedEventSchema.parse(event);
    expect(parsed.route).toBe('review');
    expect(parsed.stages.some(s => s.name === 'review')).toBe(true);
  });

  it('delegate with verifyCommand happy path (annotating outcome=passed)', () => {
    const event = makeEvent('delegate', {
      verifyCommandPresent: true,
      reviewPolicy: 'full',
      stages: [
        makeStage('implementing'),
        makeStage('review', { verdict: 'approved', roundsUsed: 1 }),
        makeStage('annotating', { outcome: 'passed' }),
        makeStage('committing'),
      ],
    });
    const parsed = ValidatedTaskCompletedEventSchema.parse(event);
    const vs = parsed.stages.find(s => s.name === 'annotating');
    expect(vs).toBeDefined();
    if (vs && 'outcome' in vs) expect(vs.outcome).toBe('passed');
  });

  it('delegate without verifyCommand (skipped, no_command)', () => {
    const event = makeEvent('delegate', {
      verifyCommandPresent: false,
      reviewPolicy: 'full',
      stages: [
        makeStage('implementing'),
        makeStage('review', { verdict: 'approved', roundsUsed: 1 }),
        makeStage('annotating', { outcome: 'skipped', skipReason: 'no_command' }),
        makeStage('committing'),
      ],
    });
    const parsed = ValidatedTaskCompletedEventSchema.parse(event);
    const vs = parsed.stages.find(s => s.name === 'annotating');
    expect(vs).toBeDefined();
    if (vs && 'outcome' in vs) expect(vs.outcome).toBe('skipped');
  });

  it('debug happy path', () => {
    const event = makeEvent('debug');
    const parsed = ValidatedTaskCompletedEventSchema.parse(event);
    expect(parsed.route).toBe('debug');
    expect(parsed.stages.some(s => s.name === 'implementing')).toBe(true);
  });

  it('investigate happy path', () => {
    const event = makeEvent('investigate');
    const parsed = ValidatedTaskCompletedEventSchema.parse(event);
    expect(parsed.route).toBe('investigate');
  });

  it('execute-plan happy path', () => {
    const event = makeEvent('execute-plan');
    const parsed = ValidatedTaskCompletedEventSchema.parse(event);
    expect(parsed.route).toBe('execute-plan');
  });

  it('retry (proxy, single implementing stage)', () => {
    const event = makeEvent('retry', {
      reviewPolicy: 'none',
      stages: [makeStage('implementing', { durationMs: 3000 }), makeStage('committing')],
    });
    const parsed = ValidatedTaskCompletedEventSchema.parse(event);
    expect(parsed.route).toBe('retry');
    expect(parsed.stages.filter(s => s.name === 'review')).toHaveLength(0);
  });

  it('terminal error', () => {
    const event = makeEvent('delegate', {
      terminalStatus: 'error' as const,
      workerStatus: 'failed' as const,
      errorCode: 'runner_crash' as const,
      stages: [makeStage('implementing')],
    });
    const parsed = ValidatedTaskCompletedEventSchema.parse(event);
    expect(parsed.terminalStatus).toBe('error');
    expect(parsed.errorCode).toBe('runner_crash');
  });

  it('terminal timeout', () => {
    const event = makeEvent('delegate', {
      terminalStatus: 'timeout' as const,
      workerStatus: 'failed' as const,
      stages: [makeStage('implementing')],
    });
    const parsed = ValidatedTaskCompletedEventSchema.parse(event);
    expect(parsed.terminalStatus).toBe('timeout');
  });

  it('terminal cost_exceeded', () => {
    const event = makeEvent('delegate', {
      terminalStatus: 'cost_exceeded' as const,
      workerStatus: 'failed' as const,
      stages: [makeStage('implementing')],
    });
    const parsed = ValidatedTaskCompletedEventSchema.parse(event);
    expect(parsed.terminalStatus).toBe('cost_exceeded');
  });

  it('terminal brief_too_vague (empty stages allowed)', () => {
    const event = makeEvent('delegate', {
      terminalStatus: 'brief_too_vague' as const,
      stages: [] as Record<string, unknown>[],
    });
    const parsed = ValidatedTaskCompletedEventSchema.parse(event);
    expect(parsed.terminalStatus).toBe('brief_too_vague');
    expect(parsed.stages).toHaveLength(0);
  });

  it('batch wrapper round-trip', () => {
    const event = ValidatedTaskCompletedEventSchema.parse(makeEvent('delegate'));
    const batch = UploadBatchSchema.parse({
      schemaVersion: 5,
      installId: 'aaaaaaaa-1111-4aaa-9999-111111111111',
      mmagentVersion: '4.0.0',
      os: 'darwin',
      nodeMajor: 22,
      events: [event],
    });
    expect(batch.events).toHaveLength(1);
    expect(batch.schemaVersion).toBe(5);
  });

  it('rejects pre-v5 schema versions in batch', () => {
    const result = UploadBatchSchema.safeParse({
      schemaVersion: 4,
      installId: 'aaaaaaaa-1111-4aaa-9999-111111111111',
      mmagentVersion: '4.0.0',
      os: 'darwin',
      nodeMajor: 22,
      events: [ValidatedTaskCompletedEventSchema.parse(makeEvent('delegate'))],
    });
    expect(result.success).toBe(false);
  });
});
