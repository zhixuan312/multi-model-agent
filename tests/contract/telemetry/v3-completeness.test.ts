import { describe, it, expect } from 'vitest';
import { buildTaskCompletedEvent } from '../../../packages/core/src/telemetry/event-builder.js';
import { ValidatedTaskCompletedEventSchema } from '../../../packages/core/src/telemetry/types.js';
import { TASK_COMPLETED_FIELD_COVERAGE, STAGE_FIELD_COVERAGE } from '../../../packages/core/src/telemetry/field-coverage.js';
import { richRunResult } from './fixtures/rich-runresult.js';

describe('V3 completeness ratchet', () => {
  it('schema parse passes on rich fixture', () => {
    const ev = buildTaskCompletedEvent({ route: 'delegate', taskSpec: { filePaths: [] }, runResult: richRunResult(), client: 'test', parentModel: 'claude-opus-4-7' });
    const result = ValidatedTaskCompletedEventSchema.safeParse(ev);
    expect(result.success).toBe(true);
  });

  it('R4: totalDurationMs >= sum of stage.durationMs even when runResult.durationMs lags by 1ms (clock-skew regression)', () => {
    // Reproduces the 3.10.2 production bug: implementing.durationMs measured
    // 1ms longer than runResult.durationMs because they sample Date.now() at
    // different ticks. Pre-fix, every emitted event got dropped at validation
    // because R4 (sum-of-stages <= total) was violated by 1ms. Builder must
    // enforce R4 by construction with Math.max(runResult.durationMs, stageSum).
    const rr = richRunResult();
    rr.durationMs = 154897;
    rr.stageStats!.implementing.durationMs = 154898;
    const ev = buildTaskCompletedEvent({ route: 'delegate', taskSpec: { filePaths: [] }, runResult: rr, client: 'test', parentModel: null });
    const stageSum = ev.stages.reduce((s, st) => s + st.durationMs, 0);
    expect(ev.totalDurationMs).toBeGreaterThanOrEqual(stageSum);
    const parsed = ValidatedTaskCompletedEventSchema.safeParse(ev);
    expect(parsed.success).toBe(true);
  });

  it('top-level totals exactly equal sum of stage costs/tokens', () => {
    const rr = richRunResult();
    const ev = buildTaskCompletedEvent({ route: 'delegate', taskSpec: { filePaths: [] }, runResult: rr, client: 'test', parentModel: null });
    const sum = (key: 'costUSD' | 'inputTokens' | 'outputTokens' | 'cachedReadTokens' | 'cachedCreationTokens' | 'reasoningTokens') =>
      ev.stages.reduce((s, st) => s + ((st as any)[key] ?? 0), 0);
    expect(ev.totalCostUSD).toBeCloseTo(sum('costUSD'), 6);
    expect(ev.inputTokens).toBe(sum('inputTokens'));
    expect(ev.outputTokens).toBe(sum('outputTokens'));
    expect(ev.cachedReadTokens).toBe(sum('cachedReadTokens'));
    expect(ev.cachedCreationTokens).toBe(sum('cachedCreationTokens'));
    expect(ev.reasoningTokens).toBe(sum('reasoningTokens'));
  });

  it('escalationCount uses the existing distinctProviders-1 formula', () => {
    const rr = richRunResult();
    const ev = buildTaskCompletedEvent({ route: 'delegate', taskSpec: { filePaths: [] }, runResult: rr, client: 'test', parentModel: null });
    const distinct = new Set(rr.escalationLog!.map(a => a.provider)).size;
    expect(ev.escalationCount).toBe(Math.max(0, distinct - 1));
  });

  it('fallbackCount derives from runResult.agents.fallbackOverrides.length', () => {
    const rr = richRunResult();
    const ev = buildTaskCompletedEvent({ route: 'delegate', taskSpec: { filePaths: [] }, runResult: rr, client: 'test', parentModel: null });
    expect(ev.fallbackCount).toBe(rr.agents!.fallbackOverrides!.length);
  });

  it('committing stage filesCommittedCount equals unique files across commits', () => {
    const rr = richRunResult();
    const ev = buildTaskCompletedEvent({ route: 'delegate', taskSpec: { filePaths: [] }, runResult: rr, client: 'test', parentModel: null });
    const commit = ev.stages.find(s => s.name === 'committing')!;
    expect((commit as any).filesCommittedCount).toBe(2); // src/a.ts, src/b.ts
    expect((commit as any).branchCreated).toBe(false);
  });

  it('verifying stage outcome and skipReason are wired', () => {
    const rr = richRunResult();
    const ev = buildTaskCompletedEvent({ route: 'delegate', taskSpec: { filePaths: [] }, runResult: rr, client: 'test', parentModel: null });
    const verify = ev.stages.find(s => s.name === 'verifying')!;
    expect((verify as any).outcome).toBe('passed');
    expect((verify as any).skipReason).toBeNull();
  });

  it('every TASK_COMPLETED field marked "derived" produces a non-default value on the rich fixture', () => {
    const rr = richRunResult();
    const ev = buildTaskCompletedEvent({ route: 'delegate', taskSpec: { filePaths: [] }, runResult: rr, client: 'test', parentModel: 'claude-opus-4-7' });
    for (const [field, cov] of Object.entries(TASK_COMPLETED_FIELD_COVERAGE)) {
      if (cov.kind !== 'derived') continue;
      const v = (ev as any)[field];
      if (field === 'capabilities' || field === 'errorCode') continue;
      if (typeof v === 'string') expect(v.length).toBeGreaterThan(0);
      if (typeof v === 'number') expect(v).not.toBe(0);
      if (Array.isArray(v))      expect(v.length).toBeGreaterThan(0);
    }
  });

  it('every STAGE_FIELD_COVERAGE entry marked "derived" produces non-default values', () => {
    const rr = richRunResult();
    const ev = buildTaskCompletedEvent({ route: 'delegate', taskSpec: { filePaths: [] }, runResult: rr, client: 'test', parentModel: 'claude-opus-4-7' });
    for (const [stageName, fields] of Object.entries(STAGE_FIELD_COVERAGE)) {
      const stage = ev.stages.find(s => s.name === stageName);
      expect(stage).toBeDefined();
      for (const [field, cov] of Object.entries(fields)) {
        if (cov.kind !== 'derived') continue;
        const v = (stage as any)[field];
        // skipReason is null when outcome != skipped (the fixture uses 'passed')
        if (field === 'skipReason') continue;
        // findingsBySeverity is an object, not a flat number/string/array
        if (field === 'findingsBySeverity') continue;
        // concernCategories may be empty for spec_review if no spec concerns
        // on the fixture; same for triggeringConcernCategories on rework stages
        if (field === 'concernCategories' || field === 'triggeringConcernCategories') {
          if (Array.isArray(v)) expect(v.length).toBeGreaterThan(0);
          continue;
        }
        if (typeof v === 'string') expect(v.length, `${stageName}.${field}`).toBeGreaterThan(0);
        if (typeof v === 'number') expect(v, `${stageName}.${field}`).not.toBe(0);
        if (Array.isArray(v))      expect(v.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('V3 clamping ratchet', () => {
  it('clamps each stage value to its per-stage schema max', () => {
    const rr = richRunResult();
    rr.stageStats!.implementing.turnCount = 999;
    rr.stageStats!.implementing.durationMs = 10 * 60 * 60 * 1000; // 10 hours
    rr.stageStats!.implementing.costUSD = 1000;
    rr.stageStats!.implementing.inputTokens = 10_000_000;
    rr.stageStats!.implementing.outputTokens = 1_000_000;
    (rr.stageStats!.implementing as any).cachedReadTokens = 10_000_000;
    (rr.stageStats!.implementing as any).cachedCreationTokens = 10_000_000;
    (rr.stageStats!.implementing as any).reasoningTokens = 1_000_000;
    rr.stageStats!.implementing.toolCallCount = 9999;
    rr.stageStats!.implementing.filesReadCount = 9999;
    rr.stageStats!.implementing.filesWrittenCount = 9999;
    // Keep durationMs high enough so R4 doesn't fire (sum of clamped stage
    // durations must not exceed totalDurationMs).
    rr.durationMs = 86_400_000;
    const ev = buildTaskCompletedEvent({ route: 'delegate', taskSpec: { filePaths: [] }, runResult: rr, client: 'test', parentModel: null });

    const impl = ev.stages.find(s => s.name === 'implementing')!;
    expect((impl as any).turnCount).toBe(250);
    expect(impl.durationMs).toBe(3_600_000);
    expect((impl as any).costUSD).toBe(100);
    expect(impl.inputTokens).toBe(5_000_000);
    expect(impl.outputTokens).toBe(500_000);
    expect((impl as any).cachedReadTokens).toBe(5_000_000);
    expect((impl as any).cachedCreationTokens).toBe(5_000_000);
    expect((impl as any).reasoningTokens).toBe(500_000);
    expect((impl as any).toolCallCount).toBe(5000);
    expect((impl as any).filesReadCount).toBe(5000);
    expect((impl as any).filesWrittenCount).toBe(5000);

    // Sanity: clamped event passes schema validation.
    const parsed = ValidatedTaskCompletedEventSchema.safeParse(ev);
    expect(parsed.success).toBe(true);
  });

  it('clamps top-level totalCostUSD to schema max when stage sum exceeds 800', () => {
    // Each entered stage costUSD is clamped to 100 at extractStageData.
    // With 8 entered stages, unclamped sum = 8 × 100 = 800, which equals the
    // schema cap. The top-level Math.min(..., 800) is a no-op in this case
    // but the test verifies that even when every stage overflows, the total
    // is contained.
    const rr = richRunResult();
    for (const s of Object.values(rr.stageStats!)) {
      if ((s as { entered: boolean }).entered) (s as { costUSD: number }).costUSD = 1000;
    }
    const ev = buildTaskCompletedEvent({ route: 'delegate', taskSpec: { filePaths: [] }, runResult: rr, client: 'test', parentModel: null });
    expect(ev.totalCostUSD).toBe(800);
    const parsed = ValidatedTaskCompletedEventSchema.safeParse(ev);
    expect(parsed.success).toBe(true);
  });

  it('clamps per-stage token values so top-level sum stays within schema bounds', () => {
    // Per-stage clamping caps each stage's tokens at schema maxima.
    // Top-level totals are independently clamped, so when the sum of clamped
    // stages still exceeds the top-level cap (e.g. one stage at 5M input +
    // other stages' contributions), the top-level total is capped.
    const rr = richRunResult();
    rr.stageStats!.implementing.inputTokens = 10_000_000;
    rr.stageStats!.implementing.outputTokens = 1_000_000;
    (rr.stageStats!.implementing as any).cachedReadTokens = 10_000_000;
    (rr.stageStats!.implementing as any).cachedCreationTokens = 10_000_000;
    (rr.stageStats!.implementing as any).reasoningTokens = 1_000_000;
    const ev = buildTaskCompletedEvent({ route: 'delegate', taskSpec: { filePaths: [] }, runResult: rr, client: 'test', parentModel: null });

    // Per-stage values are clamped.
    const impl = ev.stages.find(s => s.name === 'implementing')!;
    expect(impl.inputTokens).toBe(5_000_000);
    expect(impl.outputTokens).toBe(500_000);
    expect((impl as any).cachedReadTokens).toBe(5_000_000);
    expect((impl as any).cachedCreationTokens).toBe(5_000_000);
    expect((impl as any).reasoningTokens).toBe(500_000);

    // Top-level totals are clamped to schema maxima.
    expect(ev.inputTokens).toBe(5_000_000);
    expect(ev.outputTokens).toBe(500_000);
    expect(ev.cachedReadTokens).toBe(5_000_000);
    expect(ev.cachedCreationTokens).toBe(5_000_000);
    expect(ev.reasoningTokens).toBe(500_000);

    // Sum of per-stage (clamped) values may exceed top-level clamped total —
    // this is legal under R5 (top-level ≤ sum of stages).
    const sumInput = ev.stages.reduce((s, st) => s + st.inputTokens, 0);
    const sumOutput = ev.stages.reduce((s, st) => s + st.outputTokens, 0);
    expect(sumInput).toBeGreaterThanOrEqual(ev.inputTokens);
    expect(sumOutput).toBeGreaterThanOrEqual(ev.outputTokens);

    const parsed = ValidatedTaskCompletedEventSchema.safeParse(ev);
    expect(parsed.success).toBe(true);
  });

  it('clamps findingsBySeverity counts at 200 not 50 (Round-3 fix)', () => {
    // Round-3: raised per-bin clamp from 50 → 200 so counts between 51 and
    // 200 pass through. 60 high-severity concerns should NOT be clamped to 50.
    const rr = richRunResult();
    const concerns: Array<{ source: 'quality_review'; severity: 'high'; message: string }> = [];
    for (let i = 0; i < 60; i++) {
      concerns.push({ source: 'quality_review', severity: 'high', message: `concern-${i}` });
    }
    rr.concerns = concerns as any;
    rr.qualityReviewStatus = 'changes_required';
    const ev = buildTaskCompletedEvent({ route: 'delegate', taskSpec: { filePaths: [] }, runResult: rr, client: 'test', parentModel: null });
    const qr = ev.stages.find(s => s.name === 'quality_review');
    expect(qr).toBeDefined();
    expect((qr as any).findingsBySeverity.high).toBe(60);
  });

  it('clamps top-level totalDurationMs to schema max', () => {
    const rr = richRunResult();
    rr.durationMs = 100_000_000; // way over 86_400_000
    for (const s of Object.values(rr.stageStats!)) {
      if ((s as { entered: boolean }).entered) (s as any).durationMs = 100_000_000;
    }
    const ev = buildTaskCompletedEvent({ route: 'delegate', taskSpec: { filePaths: [] }, runResult: rr, client: 'test', parentModel: null });
    expect(ev.totalDurationMs).toBe(86_400_000);
    const parsed = ValidatedTaskCompletedEventSchema.safeParse(ev);
    expect(parsed.success).toBe(true);
  });
});
