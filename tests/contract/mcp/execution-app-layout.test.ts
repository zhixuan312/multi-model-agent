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
  elapsedMs: 4000, phaseElapsedMs: 1000,
  // The activity series is supplied by the ENGINE — the panel renders it and accumulates
  // nothing of its own, so a fixture without it is a task that has done nothing yet.
  activity: [2, 0, 3, 1], activityPhases: [1, 1, 1, 1],
  ...over,
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

/**
 * The heading is `<type> · <state>`, and both halves are the engine's own vocabulary.
 *
 * They came from different places — the type is the raw wire value, the running words were
 * hardcoded in the renderer, the terminal words come from the envelope untouched — so the
 * panel read `spec · Running` while a finished run read `investigate · done`. The same
 * heading, disagreeing with itself in two directions.
 */
describe('contract: heading casing is consistent across every state', () => {
  beforeEach(() => { document.body.innerHTML = '<main id="app"></main>'; vi.resetModules(); });

  const heading = () => document.querySelector('h2')?.textContent ?? '';

  it('never mixes a lowercase type with a capitalised state', async () => {
    const app = await boot();
    for (const payload of [
      running(),
      running({ phase: 'reviewing' }),
      running({ cancellationRequested: true }),
    ]) {
      deliver(app, payload);
      await flush();
      expect(heading(), `heading was "${heading()}"`).toBe(heading().toLowerCase());
    }
    for (const status of ['done', 'done_with_concerns', 'failed', 'cancelled', 'interrupted']) {
      deliver(app, { task: { taskId: 't1', type: 'spec', status }, metrics: {}, output: {} });
      await flush();
      expect(heading(), `heading was "${heading()}"`).toBe(heading().toLowerCase());
    }
  });

  it('reads an underscored status as English without inventing new words', async () => {
    const app = await boot();
    deliver(app, {
      task: { taskId: 't1', type: 'audit', subtype: 'plan', status: 'done_with_concerns' },
      metrics: {}, output: {},
    });
    await flush();
    // Recognisably the status it came from — not title-cased into prose, not left as a slug.
    expect(heading()).toBe('audit (plan) · done with concerns');
  });
});

describe('contract: the strip is drawn from the engine, never accumulated locally', () => {
  beforeEach(() => { document.body.innerHTML = '<main id="app"></main>'; vi.resetModules(); });

  it('renders exactly the series the engine sent, on the very first snapshot', async () => {
    // The panel used to build history from polls it personally observed, so a re-mounted
    // widget started blank and a panel opened on a finished run had nothing at all. One
    // snapshot must now be enough to draw the whole run.
    const app = await boot();
    deliver(app, running({ activity: [1, 0, 2, 5, 3], activityPhases: [1, 1, 2, 2, 2] }));
    await flush();
    const bars = [...document.querySelectorAll('.strip .bar')];
    expect(bars).toHaveLength(5);
    expect(bars.map((b) => (b.classList.contains('q') ? 0 : b.classList.contains('p2') ? 2 : 1)))
      .toEqual([1, 0, 2, 2, 2]);
    // The act change is marked once, where it actually happened.
    expect(document.querySelectorAll('.strip .seam')).toHaveLength(1);
  });

  it('draws NO strip element at all when the run has no activity yet', async () => {
    // An empty strip still carries the baseline border, and a lone horizontal rule reads as a
    // strip that failed to draw rather than a run that has not done anything.
    const app = await boot();
    const { activity: _a, activityPhases: _p, ...bare } = running();
    deliver(app, bare);
    await flush();
    expect(document.querySelector('.strip')).toBeNull();
    expect(document.querySelector('.rail')).not.toBeNull();
  });

  it('carries the series through to the terminal envelope', async () => {
    const app = await boot();
    deliver(app, {
      task: { taskId: 't1', type: 'spec', status: 'done' },
      execution: { activity: [1, 2, 0, 4], activityPhases: [1, 1, 2, 2] },
      metrics: { totalDurationMs: 1000 }, output: {},
    });
    await flush();
    expect(document.querySelectorAll('.strip .bar')).toHaveLength(4);
  });
});
