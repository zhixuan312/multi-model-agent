// @vitest-environment jsdom
/**
 * Contract: the panel's layout is ROWS, and the activity strip tells the truth about order.
 *
 * The card used to be two columns with a full-width control band bolted underneath, which left
 * the stage stretched to match a taller neighbour and the task id orphaned across a wide gap.
 * Row one is now identical in all three acts and the results are a full-width table below it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The poll loop starts as soon as the first snapshot arrives, so a mock that answers polls
 * with a fixed payload races every later delivery and silently reverts the view. This mock
 * echoes the last delivered snapshot, which is what a real daemon does.
 */
function installMockApp() {
  const state = { last: '{}' };
  const app = {
    connect: vi.fn().mockResolvedValue(undefined),
    ontoolresult: undefined as ((v: unknown) => void) | undefined,
    callServerTool: vi.fn(() => Promise.resolve({ content: [{ type: 'text', text: state.last }] })),
  };
  (window as unknown as { __MMA_CREATE_APP__: () => typeof app }).__MMA_CREATE_APP__ = () => app;
  return { app, state };
}

async function boot() {
  const { app, state } = installMockApp();
  await import('../../../packages/server/src/ui/execution/entry.js');
  await Promise.resolve();
  return Object.assign(app, { __state: state });
}

/**
 * Drain microtasks AND one macrotask turn.
 *
 * A poll is already in flight when a later snapshot is delivered; if the test asserts before
 * that poll settles, the stale response lands afterwards and reverts the view. Real polling is
 * last-write-wins by nature, so the test waits for quiescence rather than pretending otherwise.
 */
const flush = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  await new Promise((r) => { setTimeout(r, 0); });
};

const deliver = (
  app: { ontoolresult?: (v: unknown) => void; __state?: { last: string } },
  payload: unknown,
) => {
  const text = JSON.stringify(payload);
  if (app.__state) app.__state.last = text;
  app.ontoolresult?.({ content: [{ type: 'text', text }] });
};

const running = (over: Record<string, unknown> = {}) => ({
  taskId: 'task-1', type: 'spec', status: 'running', phase: 'implementing',
  elapsedMs: 4000, phaseElapsedMs: 1000, ...over,
});

describe('contract: panel layout is rows, and the stage never resizes', () => {
  beforeEach(() => { document.body.innerHTML = '<main id="app"></main>'; vi.resetModules(); });

  it('renders header, stage+rail row, and meta row while running', async () => {
    const app = await boot();
    deliver(app, running());
    await Promise.resolve();
    expect(document.querySelector('.hd')).not.toBeNull();
    expect(document.querySelector('.bd .stage svg')).not.toBeNull();
    expect(document.querySelector('.bd .rail .strip')).not.toBeNull();
    // No results table while the run is live.
    expect(document.querySelector('.tbl')).toBeNull();
  });

  it('keeps the SAME row-one structure in the terminal act, and adds a full-width table', async () => {
    const app = await boot();
    deliver(app, {
      task: { taskId: 't1', type: 'spec', status: 'done' },
      metrics: { totalDurationMs: 1000, totalCostUsd: 1 },
      output: { summary: null, filesChanged: [] },
    });
    await Promise.resolve();
    // Row one is byte-identical in shape: a stage of fixed size and a rail beside it. The
    // stage is sized purely by CSS, so nothing in the markup can stretch it per-act.
    expect(document.querySelector('.bd .stage svg')).not.toBeNull();
    expect(document.querySelector('.tbl')).not.toBeNull();
    expect(document.querySelector('.stage')?.getAttribute('style')).toBeNull();
  });

  it('puts the stop control in the header corner, not under the live data', async () => {
    const app = await boot();
    deliver(app, running());
    await Promise.resolve();
    const button = document.querySelector('button');
    expect(button).not.toBeNull();
    expect(button?.parentElement?.classList.contains('hd')).toBe(true);
  });

  it('shows no stop control once the run is terminal', async () => {
    const app = await boot();
    deliver(app, { task: { taskId: 't1', status: 'done' }, metrics: {}, output: {} });
    await Promise.resolve();
    expect(document.querySelector('button')).toBeNull();
  });

  it('marks the scene with the act, so the stage follows the engine phase', async () => {
    const app = await boot();
    deliver(app, running());
    await flush();
    expect(document.querySelector('.stage svg')?.getAttribute('class')).toContain('act-work');
    deliver(app, running({ phase: 'reviewing' }));
    await flush();
    expect(document.querySelector('.stage svg')?.getAttribute('class')).toContain('act-review');
  });
});

describe('contract: activity strip phase order is monotonic', () => {
  beforeEach(() => { document.body.innerHTML = '<main id="app"></main>'; vi.resetModules(); });

  it('never draws an Act I bar after an Act II bar', async () => {
    // History shifts out from the left as it fills, so without a clamp the older act-II bars
    // drift leftward while new act-I bars append on the right — showing review BEFORE
    // implement, a sequence that cannot happen in the engine.
    const app = await boot();
    deliver(app, running({ runningHeadline: 'a' }));
    await flush();
    deliver(app, running({ phase: 'reviewing', runningHeadline: 'b' }));
    await flush();
    // A late snapshot claiming implementing again must NOT roll the strip back.
    deliver(app, running({ phase: 'implementing', runningHeadline: 'c' }));
    await flush();

    const acts = [...document.querySelectorAll('.strip .bar')].map((b) =>
      b.classList.contains('p2') ? 2 : b.classList.contains('p1') ? 1 : 0);
    const withAct = acts.filter((a) => a > 0);
    for (let i = 1; i < withAct.length; i += 1) {
      expect(withAct[i], `bar ${i} regressed: ${withAct.join(',')}`).toBeGreaterThanOrEqual(withAct[i - 1]);
    }
    expect(withAct).toContain(2);
  });
});
