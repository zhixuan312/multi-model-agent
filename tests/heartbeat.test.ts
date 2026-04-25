import { HeartbeatTimer } from '../packages/core/src/heartbeat.js';
import type { ProgressEvent } from '../packages/core/src/runners/types.js';

describe('HeartbeatTimer', () => {
  it('requires provider at construction', () => {
    const events: ProgressEvent[] = [];
    const timer = new HeartbeatTimer((e) => events.push(e), {
      provider: 'claude-sonnet-4-6',
    });
    expect(timer).toBeDefined();
  });

  it('start() initializes all state and first tick emits correct snapshot', () => {
    const events: ProgressEvent[] = [];
    const timer = new HeartbeatTimer((e) => events.push(e), {
      provider: 'claude-sonnet-4-6',
      intervalMs: 50,
    });
    timer.start(3);

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        timer.stop();
        // First regular tick + final flush
        expect(events.length).toBeGreaterThanOrEqual(2);
        const first = events[0];
        expect(first.kind).toBe('heartbeat');
        expect(first.provider).toBe('claude-sonnet-4-6');
        expect(first.stage).toBe('implementing');
        expect(first.stageIndex).toBe(1);
        expect(first.stageCount).toBe(3);
        expect(first.reviewRound).toBeUndefined();
        expect(first.maxReviewRounds).toBeUndefined();
        expect(first.progress).toEqual({ filesRead: 0, filesWritten: 0, toolCalls: 0 });
        expect(first.costUSD).toBeNull();
        expect(first.savedCostUSD).toBeNull();
        expect(first.final).toBe(false);
        expect(first.headline).toContain('[1/3] Implementing');
        resolve();
      }, 80);
    });
  });

  it('start() does not emit immediately', () => {
    const events: ProgressEvent[] = [];
    const timer = new HeartbeatTimer((e) => events.push(e), {
      provider: 'test',
      intervalMs: 1000,
    });
    timer.start(1);
    expect(events).toHaveLength(0);
    timer.stop();
  });

  it('transition() emits eagerly with updated fields', () => {
    const events: ProgressEvent[] = [];
    const timer = new HeartbeatTimer((e) => events.push(e), {
      provider: 'claude-sonnet-4-6',
      intervalMs: 10_000,
    });
    timer.start(3);

    timer.transition({
      stage: 'spec_review',
      stageIndex: 2,
      reviewRound: 1,
      maxReviewRounds: 2,
    });

    expect(events).toHaveLength(1);
    expect(events[0].stage).toBe('spec_review');
    expect(events[0].stageIndex).toBe(2);
    expect(events[0].reviewRound).toBe(1);
    expect(events[0].maxReviewRounds).toBe(2);
    expect(events[0].final).toBe(false);
    timer.stop();
  });

  it('transition() to implementing clears reviewRound and maxReviewRounds', () => {
    const events: ProgressEvent[] = [];
    const timer = new HeartbeatTimer((e) => events.push(e), {
      provider: 'test',
      intervalMs: 10_000,
    });
    timer.start(5);
    timer.transition({ stage: 'spec_review', stageIndex: 2, reviewRound: 1, maxReviewRounds: 2 });
    events.length = 0;

    timer.transition({ stage: 'implementing', stageIndex: 3 });
    expect(events[0].reviewRound).toBeUndefined();
    expect(events[0].maxReviewRounds).toBeUndefined();
    timer.stop();
  });

  it('transition() to review stage without round fields throws', () => {
    const events: ProgressEvent[] = [];
    const timer = new HeartbeatTimer((e) => events.push(e), {
      provider: 'test',
      intervalMs: 10_000,
    });
    timer.start(3);

    expect(() => {
      timer.transition({ stage: 'spec_review', stageIndex: 2 });
    }).toThrow();
    timer.stop();
  });

  it('transition() allows stageIndex to go backwards (semantic positions)', () => {
    const events: ProgressEvent[] = [];
    const timer = new HeartbeatTimer((e) => events.push(e), {
      provider: 'test',
      intervalMs: 10_000,
    });
    timer.start(5);
    timer.transition({ stage: 'spec_review', stageIndex: 2, reviewRound: 1, maxReviewRounds: 2 });
    timer.transition({ stage: 'spec_rework', stageIndex: 3, reviewRound: 1, maxReviewRounds: 2 });
    events.length = 0;

    // Back to position 2 — allowed for review re-entry
    timer.transition({ stage: 'spec_review', stageIndex: 2, reviewRound: 2, maxReviewRounds: 2 });
    expect(events[0].stageIndex).toBe(2);
    expect(events[0].reviewRound).toBe(2);
    timer.stop();
  });

  it('transition() is suppressed before start()', () => {
    const events: ProgressEvent[] = [];
    const timer = new HeartbeatTimer((e) => events.push(e), {
      provider: 'test',
      intervalMs: 10_000,
    });

    timer.transition({ stage: 'spec_review', stageIndex: 2, reviewRound: 1, maxReviewRounds: 2 });
    expect(events).toHaveLength(0);
    timer.stop();
  });

  it('setProvider() triggers eager emit via transition()', () => {
    const events: ProgressEvent[] = [];
    const timer = new HeartbeatTimer((e) => events.push(e), {
      provider: 'provider-a',
      intervalMs: 10_000,
    });
    timer.start(1);

    timer.setProvider('provider-b');
    expect(events).toHaveLength(1);
    expect(events[0].provider).toBe('provider-b');
    timer.stop();
  });

  it('updateProgress() does not emit eagerly', () => {
    const events: ProgressEvent[] = [];
    const timer = new HeartbeatTimer((e) => events.push(e), {
      provider: 'test',
      intervalMs: 10_000,
    });
    timer.start(1);

    timer.updateProgress(5, 2, 10);
    expect(events).toHaveLength(0);
    timer.stop();
  });

  it('updateCost() does not emit eagerly', () => {
    const events: ProgressEvent[] = [];
    const timer = new HeartbeatTimer((e) => events.push(e), {
      provider: 'test',
      intervalMs: 10_000,
    });
    timer.start(1);

    timer.updateCost(0.05, 0.12);
    expect(events).toHaveLength(0);
    timer.stop();
  });

  it('stop() emits final heartbeat with final: true', () => {
    const events: ProgressEvent[] = [];
    const timer = new HeartbeatTimer((e) => events.push(e), {
      provider: 'test',
      intervalMs: 10_000,
    });
    timer.start(1);
    timer.updateProgress(3, 1, 8);
    timer.updateCost(0.05, null);

    timer.stop();
    expect(events).toHaveLength(1);
    expect(events[0].final).toBe(true);
    expect(events[0].progress.filesRead).toBe(3);
    expect(events[0].costUSD).toBe(0.05);
  });

  it('stop() is idempotent — no double final emit', () => {
    const events: ProgressEvent[] = [];
    const timer = new HeartbeatTimer((e) => events.push(e), {
      provider: 'test',
      intervalMs: 10_000,
    });
    timer.start(1);

    timer.stop();
    timer.stop();
    timer.stop();
    const finalCount = events.filter(e => e.final).length;
    expect(finalCount).toBe(1);
  });

  it('no emits after stop()', () => {
    const events: ProgressEvent[] = [];
    const timer = new HeartbeatTimer((e) => events.push(e), {
      provider: 'test',
      intervalMs: 10_000,
    });
    timer.start(1);
    timer.stop();
    const countAfterStop = events.length;

    timer.updateProgress(10, 10, 10);
    timer.transition({ stage: 'spec_review', stageIndex: 2, reviewRound: 1, maxReviewRounds: 2 });
    timer.setProvider('new-provider');
    expect(events.length).toBe(countAfterStop);
  });

  it('headline with parentModel shows saved cost', () => {
    const events: ProgressEvent[] = [];
    const timer = new HeartbeatTimer((e) => events.push(e), {
      provider: 'claude-sonnet-4-6',
      parentModel: 'claude-opus-4-6',
      intervalMs: 10_000,
    });
    timer.start(3);
    timer.updateCost(0.05, 0.12);
    timer.updateProgress(4, 2, 12);

    timer.stop();
    const final = events.find(e => e.final)!;
    expect(final.headline).toContain('$0.12 saved');
    expect(final.headline).toContain('x)');
  });

  it('headline without parentModel shows actual cost', () => {
    const events: ProgressEvent[] = [];
    const timer = new HeartbeatTimer((e) => events.push(e), {
      provider: 'claude-sonnet-4-6',
      intervalMs: 10_000,
    });
    timer.start(1);
    timer.updateCost(0.03, null);
    timer.updateProgress(4, 2, 12);

    timer.stop();
    const final = events.find(e => e.final)!;
    expect(final.headline).toContain('$0.03');
    expect(final.headline).not.toContain('saved');
  });

  it('headline omits cost when both null', () => {
    const events: ProgressEvent[] = [];
    const timer = new HeartbeatTimer((e) => events.push(e), {
      provider: 'test',
      intervalMs: 10_000,
    });
    timer.start(1);

    timer.stop();
    const final = events.find(e => e.final)!;
    expect(final.headline).not.toContain('$');
  });

  it('getHeartbeatTickInfo() returns a rich per-stage headline matching the onProgress one', () => {
    const events: ProgressEvent[] = [];
    const timer = new HeartbeatTimer((e) => events.push(e), {
      provider: 'gpt-5.4',
      parentModel: 'claude-opus-4-7',
      intervalMs: 10_000,
      batchId: 'b-1',
    });
    timer.start(5);
    timer.transition({ stage: 'spec_review', stageIndex: 3, reviewRound: 1, maxReviewRounds: 2 });
    timer.updateProgress(2, 1, 7);
    timer.updateCost(0.03, 0.12);

    const tick = timer.getHeartbeatTickInfo();
    expect(tick.headline).toContain('[3/5] Spec review');
    expect(tick.headline).toContain('(round 1/2)');
    expect(tick.headline).toContain('(gpt-5.4)');
    expect(tick.headline).toContain('2 read');
    expect(tick.headline).toContain('1 written');
    expect(tick.headline).toContain('7 tool calls');
    expect(tick.headline).toContain('$0.12 saved');
    timer.stop();
  });

  it('updateStageCount() changes denominator', () => {
    const events: ProgressEvent[] = [];
    const timer = new HeartbeatTimer((e) => events.push(e), {
      provider: 'test',
      intervalMs: 10_000,
    });
    timer.start(5);
    timer.transition({ stage: 'spec_review', stageIndex: 2, reviewRound: 1, maxReviewRounds: 2 });
    events.length = 0;

    timer.updateStageCount(4);
    expect(events).toHaveLength(0); // non-eager: no emit
    timer.stop();
    expect(events[0].stageCount).toBe(4); // visible in final flush
  });

  it('updateProgress() and updateCost() are no-ops before start()', () => {
    const events: ProgressEvent[] = [];
    const timer = new HeartbeatTimer((e) => events.push(e), {
      provider: 'test',
      intervalMs: 10_000,
    });
    timer.updateProgress(5, 3, 10);
    timer.updateCost(0.05, 0.10);
    timer.start(1);
    timer.stop();
    const final = events.find(e => e.final)!;
    expect(final.progress.filesRead).toBe(0);
    expect(final.costUSD).toBeNull();
  });

  it('updateStageCount() throws when below current stageIndex', () => {
    const events: ProgressEvent[] = [];
    const timer = new HeartbeatTimer((e) => events.push(e), {
      provider: 'test',
      intervalMs: 10_000,
    });
    timer.start(5);
    timer.transition({ stage: 'quality_review', stageIndex: 4, reviewRound: 1, maxReviewRounds: 2 });
    expect(() => timer.updateStageCount(3)).toThrow();
    timer.stop();
  });

  it('start() throws on invalid stageCount', () => {
    const events: ProgressEvent[] = [];
    const timer = new HeartbeatTimer((e) => events.push(e), {
      provider: 'test',
      intervalMs: 10_000,
    });
    expect(() => timer.start(0)).toThrow();
    expect(() => timer.start(-1)).toThrow();
  });

  it('transition() throws on stageIndex < 1', () => {
    const events: ProgressEvent[] = [];
    const timer = new HeartbeatTimer((e) => events.push(e), {
      provider: 'test',
      intervalMs: 10_000,
    });
    timer.start(3);
    expect(() => timer.transition({ stageIndex: 0 })).toThrow();
    timer.stop();
  });

  it('transition() rejects review fields while in implementing stage', () => {
    const events: ProgressEvent[] = [];
    const timer = new HeartbeatTimer((e) => events.push(e), {
      provider: 'test',
      intervalMs: 10_000,
    });
    timer.start(3);
    expect(() => timer.transition({ reviewRound: 1, maxReviewRounds: 2 })).toThrow();
    timer.stop();
  });

});
