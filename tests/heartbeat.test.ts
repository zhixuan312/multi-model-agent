import { describe, it, expect, vi, afterEach } from 'vitest';
import { HeartbeatTimer } from '@zhixuan92/multi-model-agent-core/heartbeat';

describe('HeartbeatTimer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits heartbeat events at the configured interval', () => {
    vi.useFakeTimers();
    const events: any[] = [];
    const onProgress = (event: any) => events.push(event);

    const hb = new HeartbeatTimer(onProgress, { intervalMs: 5000 });
    hb.start('implementing');

    vi.advanceTimersByTime(5000);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'heartbeat',
      phase: 'implementing',
      turnsCompleted: 0,
    });
    expect(events[0].elapsedMs).toBeGreaterThanOrEqual(5000);

    vi.advanceTimersByTime(5000);
    expect(events).toHaveLength(2);

    hb.stop();
    vi.advanceTimersByTime(10000);
    expect(events).toHaveLength(2);
  });

  it('tracks turns via incrementTurns()', () => {
    vi.useFakeTimers();
    const events: any[] = [];
    const hb = new HeartbeatTimer((e) => events.push(e), { intervalMs: 5000 });
    hb.start('implementing');
    hb.incrementTurns();
    hb.incrementTurns();

    vi.advanceTimersByTime(5000);
    expect(events[0].turnsCompleted).toBe(2);
    hb.stop();
  });

  it('updates phase via setPhase()', () => {
    vi.useFakeTimers();
    const events: any[] = [];
    const hb = new HeartbeatTimer((e) => events.push(e), { intervalMs: 5000 });
    hb.start('implementing');

    vi.advanceTimersByTime(5000);
    expect(events[0].phase).toBe('implementing');

    hb.setPhase('reviewing');
    vi.advanceTimersByTime(5000);
    expect(events[1].phase).toBe('reviewing');
    hb.stop();
  });
});
