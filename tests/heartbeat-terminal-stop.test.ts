import { ActivityTracker } from '../packages/core/src/bounded-execution/activity-tracker.js';
import type { ProgressEvent } from '../packages/core/src/providers/runner-types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('ActivityTracker terminal-stage auto-stop (P4)', () => {
  it('does not emit interval ticks after setStage("terminal")', async () => {
    const events: ProgressEvent[] = [];
    const hb = new ActivityTracker((e) => events.push(e), {
      provider: 'claude-sonnet-4-6',
      intervalMs: 50,
    });
    hb.start(3);
    // Let at least one regular tick fire.
    await sleep(120);
    hb.setStage('terminal', 3);
    // setStage(terminal) emits the transition + auto-stop's final flush.
    const afterTerminal = events.length;
    // Wait long enough that several intervalMs would have fired had the
    // timer not been cleared.
    await sleep(200);
    expect(events.length).toBe(afterTerminal);
  });

  it('further heartbeat methods after terminal are no-ops', async () => {
    const events: ProgressEvent[] = [];
    const hb = new ActivityTracker((e) => events.push(e), {
      provider: 'claude-sonnet-4-6',
      intervalMs: 50,
    });
    hb.start(3);
    hb.setStage('terminal', 3);
    const after = events.length;
    hb.updateProgress(1);
    hb.updateCost(1, null);
    hb.markEvent('llm');
    expect(events.length).toBe(after);
  });
});
