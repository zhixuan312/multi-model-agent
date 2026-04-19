import { describe, it, expect, vi, afterEach } from 'vitest';
import { HeartbeatTimer, STALL_HEARTBEAT_THRESHOLD } from '@zhixuan92/multi-model-agent-core/heartbeat';

describe('HeartbeatTimer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits heartbeat with stage, progress, and headline', () => {
    vi.useFakeTimers();
    const events: any[] = [];
    const hb = new HeartbeatTimer((e) => events.push(e), { intervalMs: 5000 });
    hb.start(5);
    hb.updateProgress(2, 1, 4);

    vi.advanceTimersByTime(5000);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'heartbeat',
      stage: 'implementing',
      stageIndex: 1,
      stageCount: 5,
      progress: { filesRead: 2, filesWritten: 1, toolCalls: 4, stalled: false },
    });
    expect(events[0].elapsed).toBe('5s');
    expect(events[0].headline).toBe('[1/5] Implementing — 5s, 2 read, 1 written, 4 tool calls');
    expect(events[0].reviewRound).toBeUndefined();
    expect(events[0].maxReviewRounds).toBeUndefined();
    hb.stop();
  });

  it('includes reviewRound and maxReviewRounds for review stages', () => {
    vi.useFakeTimers();
    const events: any[] = [];
    const hb = new HeartbeatTimer((e) => events.push(e), { intervalMs: 5000 });
    hb.start(5);
    hb.setStage('spec_review', 2, 1, 10);
    hb.updateProgress(5, 3, 10);

    vi.advanceTimersByTime(5000);
    expect(events[0]).toMatchObject({
      stage: 'spec_review',
      stageIndex: 2,
      reviewRound: 1,
      maxReviewRounds: 10,
    });
    expect(events[0].headline).toBe('[2/5] Spec review (round 1/10) — 5s, 5 read, 3 written, 10 tool calls');
    hb.stop();
  });

  it('jumps stageIndex when rework is skipped', () => {
    vi.useFakeTimers();
    const events: any[] = [];
    const hb = new HeartbeatTimer((e) => events.push(e), { intervalMs: 5000 });
    hb.start(5);

    // Spec review approved on round 1, skip spec_rework, jump to quality_review
    hb.setStage('spec_review', 2, 1, 10);
    hb.setStage('quality_review', 4, 1, 10);
    hb.updateProgress(10, 5, 20);

    vi.advanceTimersByTime(5000);
    expect(events[0]).toMatchObject({ stageIndex: 4, stageCount: 5, stage: 'quality_review' });
    expect(events[0].headline).toContain('[4/5] Quality review');
    hb.stop();
  });

  it('uses stageCount=1 for no-artifact tasks', () => {
    vi.useFakeTimers();
    const events: any[] = [];
    const hb = new HeartbeatTimer((e) => events.push(e), { intervalMs: 5000 });
    hb.start(1);
    hb.updateProgress(3, 0, 5);

    vi.advanceTimersByTime(5000);
    expect(events[0]).toMatchObject({ stageIndex: 1, stageCount: 1, stage: 'implementing' });
    expect(events[0].headline).toBe('[1/1] Implementing — 5s, 3 read, 0 written, 5 tool calls');
    hb.stop();
  });

  it('detects stall after STALL_HEARTBEAT_THRESHOLD unchanged heartbeats', () => {
    vi.useFakeTimers();
    const events: any[] = [];
    const hb = new HeartbeatTimer((e) => events.push(e), { intervalMs: 5000 });
    hb.start(5);
    hb.updateProgress(2, 1, 4);

    // First heartbeat: establishes baseline
    vi.advanceTimersByTime(5000);
    expect(events[0].progress.stalled).toBe(false);

    // Heartbeats 2 through STALL_HEARTBEAT_THRESHOLD: toolCalls unchanged
    for (let i = 1; i < STALL_HEARTBEAT_THRESHOLD; i++) {
      vi.advanceTimersByTime(5000);
      expect(events[i].progress.stalled).toBe(false);
    }

    // Heartbeat STALL_HEARTBEAT_THRESHOLD + 1: stalled
    vi.advanceTimersByTime(5000);
    expect(events[STALL_HEARTBEAT_THRESHOLD].progress.stalled).toBe(true);
    expect(events[STALL_HEARTBEAT_THRESHOLD].headline).toContain('— stalled');
    hb.stop();
  });

  it('resets stall when toolCalls increases', () => {
    vi.useFakeTimers();
    const events: any[] = [];
    const hb = new HeartbeatTimer((e) => events.push(e), { intervalMs: 5000 });
    hb.start(5);
    hb.updateProgress(2, 1, 4);

    // Accumulate stall count
    for (let i = 0; i < STALL_HEARTBEAT_THRESHOLD + 1; i++) {
      vi.advanceTimersByTime(5000);
    }
    expect(events[events.length - 1].progress.stalled).toBe(true);

    // New tool call resets stall
    hb.updateProgress(3, 1, 5);
    vi.advanceTimersByTime(5000);
    expect(events[events.length - 1].progress.stalled).toBe(false);
    hb.stop();
  });

  it('resets stall when stage changes', () => {
    vi.useFakeTimers();
    const events: any[] = [];
    const hb = new HeartbeatTimer((e) => events.push(e), { intervalMs: 5000 });
    hb.start(5);
    hb.updateProgress(2, 1, 4);

    // Accumulate stall count
    for (let i = 0; i < STALL_HEARTBEAT_THRESHOLD + 1; i++) {
      vi.advanceTimersByTime(5000);
    }
    expect(events[events.length - 1].progress.stalled).toBe(true);

    // Stage change resets stall
    hb.setStage('spec_review', 2, 1, 10);
    vi.advanceTimersByTime(5000);
    expect(events[events.length - 1].progress.stalled).toBe(false);
    hb.stop();
  });

  it('does not increment stall counter when in-flight', () => {
    vi.useFakeTimers();
    const events: any[] = [];
    const hb = new HeartbeatTimer((e) => events.push(e), { intervalMs: 5000 });
    hb.start(5);
    hb.updateProgress(2, 1, 4);
    hb.setInFlight(true);

    // Many heartbeats while in-flight — should not stall
    for (let i = 0; i < STALL_HEARTBEAT_THRESHOLD + 3; i++) {
      vi.advanceTimersByTime(5000);
    }
    expect(events[events.length - 1].progress.stalled).toBe(false);

    // End in-flight, now stall counter starts
    hb.setInFlight(false);
    for (let i = 0; i < STALL_HEARTBEAT_THRESHOLD + 1; i++) {
      vi.advanceTimersByTime(5000);
    }
    expect(events[events.length - 1].progress.stalled).toBe(true);
    hb.stop();
  });

  it('formats elapsed as minutes and seconds at 60+', () => {
    vi.useFakeTimers();
    const events: any[] = [];
    const hb = new HeartbeatTimer((e) => events.push(e), { intervalMs: 90_000 });
    hb.start(1);

    vi.advanceTimersByTime(90_000);
    expect(events[0].elapsed).toBe('1m 30s');
    hb.stop();
  });

  it('stops emitting after stop()', () => {
    vi.useFakeTimers();
    const events: any[] = [];
    const hb = new HeartbeatTimer((e) => events.push(e), { intervalMs: 5000 });
    hb.start(1);

    vi.advanceTimersByTime(5000);
    expect(events).toHaveLength(1);
    hb.stop();
    vi.advanceTimersByTime(10000);
    expect(events).toHaveLength(1);
  });
});
