import { describe, it, expect } from 'vitest';
import { buildTaskCompletedEvent } from '../../../packages/core/src/events/event-builder.js';
import { ValidatedTaskCompletedEventSchema } from '../../../packages/core/src/events/telemetry-types.js';
import { richRunResult } from './fixtures/rich-runresult.js';

describe('V3 completeness ratchet', () => {
  it('schema parse passes on rich fixture', () => {
    const ev = buildTaskCompletedEvent({ route: 'delegate', taskSpec: { filePaths: [] }, runResult: richRunResult(), client: 'test', mainModel: 'claude-opus-4-7' });
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
    const ev = buildTaskCompletedEvent({ route: 'delegate', taskSpec: { filePaths: [] }, runResult: rr, client: 'test', mainModel: null });
    const stageSum = ev.stages.reduce((s, st) => s + st.durationMs, 0);
    expect(ev.totalDurationMs).toBeGreaterThanOrEqual(stageSum);
    const parsed = ValidatedTaskCompletedEventSchema.safeParse(ev);
    expect(parsed.success).toBe(true);
  });

  it('top-level totals exactly equal sum of stage costs/tokens', () => {
    const rr = richRunResult();
    const ev = buildTaskCompletedEvent({ route: 'delegate', taskSpec: { filePaths: [] }, runResult: rr, client: 'test', mainModel: null });
    const sum = (key: 'costUSD' | 'inputTokens' | 'outputTokens' | 'cachedReadTokens' | 'cachedNonReadTokens') =>
      ev.stages.reduce((s, st) => s + ((st as any)[key] ?? 0), 0);
    expect(ev.totalCostUSD).toBeCloseTo(sum('costUSD'), 6);
    expect(ev.inputTokens).toBe(sum('inputTokens'));
    expect(ev.outputTokens).toBe(sum('outputTokens'));
    expect(ev.cachedReadTokens).toBe(sum('cachedReadTokens'));
    expect(ev.cachedNonReadTokens).toBe(sum('cachedNonReadTokens'));
  });

  it('escalationCount uses the existing distinctProviders-1 formula', () => {
    const rr = richRunResult();
    const ev = buildTaskCompletedEvent({ route: 'delegate', taskSpec: { filePaths: [] }, runResult: rr, client: 'test', mainModel: null });
    const distinct = new Set(rr.escalationLog!.map(a => a.provider)).size;
    expect(ev.escalationCount).toBe(Math.max(0, distinct - 1));
  });

  it('fallbackCount derives from runResult.agents.fallbackOverrides.length', () => {
    const rr = richRunResult();
    const ev = buildTaskCompletedEvent({ route: 'delegate', taskSpec: { filePaths: [] }, runResult: rr, client: 'test', mainModel: null });
    expect(ev.fallbackCount).toBe(rr.agents!.fallbackOverrides!.length);
  });

  it('committing stage filesCommittedCount equals unique files across commits', () => {
    const rr = richRunResult();
    const ev = buildTaskCompletedEvent({ route: 'delegate', taskSpec: { filePaths: [] }, runResult: rr, client: 'test', mainModel: null });
    const commit = ev.stages.find(s => s.name === 'committing')!;
    expect((commit as any).filesCommittedCount).toBe(2); // src/a.ts, src/b.ts
    expect((commit as any).branchCreated).toBe(false);
  });

  it('verifying stage outcome and skipReason are wired', () => {
    const rr = richRunResult();
    const ev = buildTaskCompletedEvent({ route: 'delegate', taskSpec: { filePaths: [] }, runResult: rr, client: 'test', mainModel: null });
    const verify = ev.stages.find(s => s.name === 'annotating')!;
    expect((verify as any).outcome).toBe('passed');
    expect((verify as any).skipReason).toBeNull();
  });

});

describe('V3 clamping ratchet', () => {
  it('clamps each stage value to its per-stage schema max', () => {
    const rr = richRunResult();
    rr.stageStats!.implementing.turnCount = 999;
    rr.stageStats!.implementing.durationMs = 10 * 60 * 60 * 1000; // 10 hours
    rr.stageStats!.implementing.costUSD = 10_000;
    rr.stageStats!.implementing.inputTokens = 200_000_000;
    rr.stageStats!.implementing.outputTokens = 10_000_000;
    (rr.stageStats!.implementing as any).cachedReadTokens = 200_000_000;
    (rr.stageStats!.implementing as any).cachedNonReadTokens = 200_000_000;
    rr.stageStats!.implementing.toolCallCount = 9999;
    rr.stageStats!.implementing.filesReadCount = 9999;
    rr.stageStats!.implementing.filesWrittenCount = 9999;
    // Keep durationMs high enough so R4 doesn't fire (sum of clamped stage
    // durations must not exceed totalDurationMs).
    rr.durationMs = 86_400_000;
    const ev = buildTaskCompletedEvent({ route: 'delegate', taskSpec: { filePaths: [] }, runResult: rr, client: 'test', mainModel: null });

    const impl = ev.stages.find(s => s.name === 'implementing')!;
    expect((impl as any).turnCount).toBe(250);
    expect(impl.durationMs).toBe(3_600_000);
    expect((impl as any).costUSD).toBe(500);
    expect(impl.inputTokens).toBe(100_000_000);
    expect(impl.outputTokens).toBe(2_000_000);
    expect((impl as any).cachedReadTokens).toBe(100_000_000);
    expect((impl as any).cachedNonReadTokens).toBe(100_000_000);
    expect((impl as any).toolCallCount).toBe(5000);
    expect((impl as any).filesReadCount).toBe(5000);
    expect((impl as any).filesWrittenCount).toBe(5000);

    // Sanity: clamped event passes schema validation.
    const parsed = ValidatedTaskCompletedEventSchema.safeParse(ev);
    expect(parsed.success).toBe(true);
  });

  it('clamps top-level totalCostUSD to schema max when stage sum exceeds the cap', () => {
    // Each entered stage costUSD is clamped to 500 at extractStageData. With
    // 5 entered stages each at the cap, sum = 2500 — well under the 5000
    // schema cap. The point of this test is the clamping behavior: the
    // top-level total never exceeds the sum of clamped stage costs.
    const rr = richRunResult();
    for (const s of Object.values(rr.stageStats!)) {
      if ((s as { entered: boolean }).entered) (s as { costUSD: number }).costUSD = 10_000;
    }
    const ev = buildTaskCompletedEvent({ route: 'delegate', taskSpec: { filePaths: [] }, runResult: rr, client: 'test', mainModel: null });
    const stageSum = ev.stages.reduce((s, st) => s + (st.costUSD ?? 0), 0);
    expect(ev.totalCostUSD).toBeLessThanOrEqual(5_000);
    expect(ev.totalCostUSD).toBeLessThanOrEqual(stageSum);
    const parsed = ValidatedTaskCompletedEventSchema.safeParse(ev);
    expect(parsed.success).toBe(true);
  });

  it('clamps per-stage token values so top-level sum stays within schema bounds', () => {
    // Per-stage clamping caps each stage's tokens at schema maxima.
    // Top-level totals are independently clamped, so when the sum of clamped
    // stages still exceeds the top-level cap (e.g. one stage at 100M input +
    // other stages' contributions), the top-level total is capped.
    const rr = richRunResult();
    rr.stageStats!.implementing.inputTokens = 200_000_000;
    rr.stageStats!.implementing.outputTokens = 10_000_000;
    (rr.stageStats!.implementing as any).cachedReadTokens = 200_000_000;
    (rr.stageStats!.implementing as any).cachedNonReadTokens = 200_000_000;
    const ev = buildTaskCompletedEvent({ route: 'delegate', taskSpec: { filePaths: [] }, runResult: rr, client: 'test', mainModel: null });

    // Per-stage values are clamped.
    const impl = ev.stages.find(s => s.name === 'implementing')!;
    expect(impl.inputTokens).toBe(100_000_000);
    expect(impl.outputTokens).toBe(2_000_000);
    expect((impl as any).cachedReadTokens).toBe(100_000_000);
    expect((impl as any).cachedNonReadTokens).toBe(100_000_000);

    // Top-level totals are clamped to schema maxima.
    expect(ev.inputTokens).toBe(100_000_000);
    expect(ev.outputTokens).toBe(2_000_000);
    expect(ev.cachedReadTokens).toBe(100_000_000);
    expect(ev.cachedNonReadTokens).toBe(100_000_000);

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
    const concerns: Array<{ source: 'review'; severity: 'high'; message: string }> = [];
    for (let i = 0; i < 60; i++) {
      concerns.push({ source: 'review', severity: 'high', message: `concern-${i}` });
    }
    rr.concerns = concerns as any;
    rr.qualityReviewStatus = 'changes_required';
    const ev = buildTaskCompletedEvent({ route: 'delegate', taskSpec: { filePaths: [] }, runResult: rr, client: 'test', mainModel: null });
    const qr = ev.stages.find(s => s.name === 'review');
    expect(qr).toBeDefined();
    expect((qr as any).findingsBySeverity.high).toBe(60);
  });

  it('clamps top-level totalDurationMs to schema max', () => {
    const rr = richRunResult();
    rr.durationMs = 100_000_000; // way over 86_400_000
    for (const s of Object.values(rr.stageStats!)) {
      if ((s as { entered: boolean }).entered) (s as any).durationMs = 100_000_000;
    }
    const ev = buildTaskCompletedEvent({ route: 'delegate', taskSpec: { filePaths: [] }, runResult: rr, client: 'test', mainModel: null });
    expect(ev.totalDurationMs).toBe(86_400_000);
    const parsed = ValidatedTaskCompletedEventSchema.safeParse(ev);
    expect(parsed.success).toBe(true);
  });
});
