import { describe, it, expect } from 'vitest';
import { ValidatedTaskCompletedEventSchema, UploadBatchSchema } from '../../../packages/core/src/telemetry/types.js';

function makeStage(name: string, overrides: Record<string, unknown> = {}) {
  const base: Record<string, unknown> = {
    name,
    model: 'claude-sonnet',
    agentTier: 'standard' as const,
    durationMs: 5000,
    costUSD: 0.01,
    inputTokens: 100,
    outputTokens: 80,
    cachedTokens: 0,
    reasoningTokens: 0,
    toolCallCount: 5,
    filesReadCount: 3,
    filesWrittenCount: 1,
    turnCount: 3,
    maxIdleMs: null,
    totalIdleMs: null,
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
    case 'spec_review':
    case 'quality_review':
    case 'diff_review':
      return {
        ...base,
        verdict: 'approved' as const,
        roundsUsed: 1,
        concernCategories: [] as string[],
        findingsBySeverity: { high: 0, medium: 0, low: 0, style: 0 },
        ...overrides,
        name,
      } as const;
    case 'spec_rework':
    case 'quality_rework':
      return {
        ...base,
        triggeringConcernCategories: [] as string[],
        ...overrides,
        name,
      } as const;
    case 'verifying':
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
    capabilities: [] as string[],
    reviewPolicy: route === 'delegate' ? 'full' as const : 'quality_only' as const,
    verifyCommandPresent: route === 'verify',
    implementerModel: 'claude-sonnet',
    terminalStatus: 'ok' as const,
    workerStatus: 'done' as const,
    errorCode: null,
    parentModelFamily: 'claude' as const,
    inputTokens: sum('inputTokens'),
    outputTokens: sum('outputTokens'),
    cachedTokens: sum('cachedTokens'),
    reasoningTokens: sum('reasoningTokens'),
    totalDurationMs: sum('durationMs'),
    totalCostUSD: stages.reduce((s, st) => s + ((st.costUSD as number) ?? 0), 0),
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

function getDefaultStages(route: string) {
  const stages = [makeStage('implementing')];

  if (route === 'delegate' || route === 'execute-plan') {
    stages.push(makeStage('spec_review'));
    stages.push(makeStage('quality_review'));
    stages.push(makeStage('verifying'));
  } else if (['audit', 'review', 'verify', 'debug', 'investigate'].includes(route)) {
    stages.push(makeStage('quality_review', { verdict: 'annotated' }));
  }

  stages.push(makeStage('committing'));
  return stages;
}

describe('V3 envelope contract', () => {
  it('delegate happy path (full review, 5 stages)', () => {
    const event = makeEvent('delegate');
    const parsed = ValidatedTaskCompletedEventSchema.parse(event);
    expect(parsed.stages).toHaveLength(5);
    expect(parsed.route).toBe('delegate');
    expect(parsed.terminalStatus).toBe('ok');
  });

  it('delegate no rework (all approved round 1)', () => {
    const event = makeEvent('delegate', {
      stages: [
        makeStage('implementing'),
        makeStage('spec_review', { verdict: 'approved', roundsUsed: 1 }),
        makeStage('quality_review', { verdict: 'approved', roundsUsed: 1 }),
        makeStage('verifying', { outcome: 'passed' }),
        makeStage('committing'),
      ],
    });
    const parsed = ValidatedTaskCompletedEventSchema.parse(event);
    expect(parsed.stages).toHaveLength(5);
  });

  it('audit happy path (quality_only, annotated verdict)', () => {
    const event = makeEvent('audit');
    const parsed = ValidatedTaskCompletedEventSchema.parse(event);
    expect(parsed.route).toBe('audit');
    const qr = parsed.stages.find(s => s.name === 'quality_review');
    expect(qr).toBeDefined();
    if (qr && 'verdict' in qr) expect(qr.verdict).toBe('annotated');
  });

  it('review happy path (quality_only default)', () => {
    const event = makeEvent('review');
    const parsed = ValidatedTaskCompletedEventSchema.parse(event);
    expect(parsed.route).toBe('review');
    expect(parsed.stages.some(s => s.name === 'quality_review')).toBe(true);
    expect(parsed.stages.some(s => s.name === 'spec_review')).toBe(false);
  });

  it('verify happy path (verifying outcome=passed)', () => {
    const event = makeEvent('verify', {
      verifyCommandPresent: true,
      reviewPolicy: 'quality_only',
      stages: [
        makeStage('implementing'),
        makeStage('quality_review', { verdict: 'annotated' }),
        makeStage('verifying', { outcome: 'passed' }),
        makeStage('committing'),
      ],
    });
    const parsed = ValidatedTaskCompletedEventSchema.parse(event);
    const vs = parsed.stages.find(s => s.name === 'verifying');
    expect(vs).toBeDefined();
    if (vs && 'outcome' in vs) expect(vs.outcome).toBe('passed');
  });

  it('verify skipped (no command)', () => {
    const event = makeEvent('verify', {
      verifyCommandPresent: false,
      reviewPolicy: 'quality_only',
      stages: [
        makeStage('implementing'),
        makeStage('quality_review', { verdict: 'annotated' }),
        makeStage('verifying', { outcome: 'skipped', skipReason: 'no_command' }),
        makeStage('committing'),
      ],
    });
    const parsed = ValidatedTaskCompletedEventSchema.parse(event);
    const vs = parsed.stages.find(s => s.name === 'verifying');
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
    expect(parsed.stages.filter(s => s.name === 'quality_review')).toHaveLength(0);
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
      schemaVersion: 3,
      installId: 'aaaaaaaa-1111-4aaa-9999-111111111111',
      mmagentVersion: '3.10.0',
      os: 'darwin',
      nodeMajor: 22,
      events: [event],
    });
    expect(batch.events).toHaveLength(1);
    expect(batch.schemaVersion).toBe(3);
  });

  it('rejects V2 schema version in batch', () => {
    const result = UploadBatchSchema.safeParse({
      schemaVersion: 2,
      installId: 'aaaaaaaa-1111-4aaa-9999-111111111111',
      mmagentVersion: '2.0.0',
      os: 'darwin',
      nodeMajor: 22,
      events: [ValidatedTaskCompletedEventSchema.parse(makeEvent('delegate'))],
    });
    expect(result.success).toBe(false);
  });
});
