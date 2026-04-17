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
    expect(events[0].elapsed).toBe('5s');

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

  it('formats elapsed as minutes and seconds at 60+', () => {
    vi.useFakeTimers();
    const events: any[] = [];
    const hb = new HeartbeatTimer((e) => events.push(e), { intervalMs: 90_000 });
    hb.start('implementing');

    vi.advanceTimersByTime(90_000);
    expect(events[0].elapsed).toBe('1m 30s');
    hb.stop();
  });

  it('does not produce "Xm 60s" at minute boundaries', () => {
    vi.useFakeTimers();
    const events: any[] = [];
    // 119500ms = 119.5s → rounds to 120s = 2m 0s, not 1m 60s
    const hb = new HeartbeatTimer((e) => events.push(e), { intervalMs: 119_500 });
    hb.start('implementing');

    vi.advanceTimersByTime(119_500);
    expect(events[0].elapsed).toBe('2m 0s');
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
