// @vitest-environment jsdom
import { readFile } from 'node:fs/promises';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>((res) => { resolve = res; }); return { promise, resolve }; }

/**
 * Read the calls off the spy itself rather than a manual array pushed from the default
 * implementation. `mockReturnValueOnce`/`mockResolvedValueOnce` REPLACE that implementation
 * for the call they cover, so a hand-rolled recorder silently misses exactly the calls a
 * test overrides — which reads as "the App never polled" when in fact it did.
 */
function callsOf(app: { callServerTool: ReturnType<typeof vi.fn> }) {
  return app.callServerTool.mock.calls.map(
    ([call]) => call as { name: string; arguments: Record<string, unknown> }
  );
}

function installMockApp() {
  const app = {
    connect: vi.fn().mockResolvedValue(undefined),
    ontoolresult: undefined as ((v: unknown) => void) | undefined,
    callServerTool: vi.fn(() =>
      Promise.resolve({ content: [{ type: 'text', text: JSON.stringify({
        taskId: 'task-1', status: 'running', phase: 'execute', elapsedMs: 2000, phaseElapsedMs: 500, startedAt: '2026-01-01T00:00:00.000Z',
      }) }] })
    ),
  };
  (window as unknown as { __MMA_CREATE_APP__: () => typeof app }).__MMA_CREATE_APP__ = () => app;
  return { app };
}

const runningEnvelope = { content: [{ type: 'text', text: JSON.stringify({
  taskId: 'task-1', status: 'running', phase: 'queue', elapsedMs: 0, phaseElapsedMs: 0, startedAt: '2026-01-01T00:00:00.000Z',
}) }] };
const alreadyTerminalEnvelope = { content: [{ type: 'text', text: JSON.stringify({
  task: { taskId: 't-inline', status: 'done' }, metrics: { totalCostUsd: 0.01, savedVsMainCostUsd: 0.02 }, output: { summary: 'short task, ran inline' },
}) }] };

describe('contract: execution App bootstrap wiring', () => {
  beforeEach(() => { document.body.innerHTML = '<main id="app"></main>'; vi.resetModules(); });
  afterEach(() => { vi.useRealTimers(); });

  it('connects, then polls mma_task_get with the taskId from the initiating running result', async () => {
    const { app } = installMockApp();
    await import('../../../packages/server/src/ui/execution/entry.js');
    await Promise.resolve();
    expect(app.connect).toHaveBeenCalledTimes(1);
    app.ontoolresult?.(runningEnvelope);
    await Promise.resolve();
    expect(callsOf(app)).toContainEqual({ name: 'mma_task_get', arguments: { taskId: 'task-1' } });
  });

  it('renders an already-terminal initiating result immediately and never calls callServerTool', async () => {
    const { app } = installMockApp();
    await import('../../../packages/server/src/ui/execution/entry.js');
    await Promise.resolve();
    app.ontoolresult?.(alreadyTerminalEnvelope);
    await Promise.resolve();
    expect(callsOf(app)).toHaveLength(0);
    expect(document.body.textContent).toContain('done');
    expect(document.querySelector('button')).toBeNull();
  });

  it('never overlaps polls, counts a hung 10s poll as one failure, and stops after five consecutive failures', async () => {
    vi.useFakeTimers();
    const { app } = installMockApp();
    const pending = deferred<unknown>();
    app.callServerTool.mockReturnValueOnce(pending.promise as never);
    await import('../../../packages/server/src/ui/execution/entry.js');
    await vi.advanceTimersByTimeAsync(0);
    app.ontoolresult?.(runningEnvelope);
    await vi.advanceTimersByTimeAsync(0);
    expect(callsOf(app)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000); // must NOT start a second poll while the first is unsettled
    expect(callsOf(app)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(8_000); // crosses the 10,000ms per-poll timeout (total 10s)
    app.callServerTool.mockRejectedValue(new Error('offline'));
    await vi.advanceTimersByTimeAsync(2_000 * 4); // 4 more failures = 5 consecutive total
    expect(document.body.textContent).toMatch(/stopped/i);
    expect(document.body.textContent).toMatch(/offline/i);
  });

  it('disables Cancel from click until a confirming snapshot, not merely on promise resolution', async () => {
    vi.useFakeTimers();
    const { app } = installMockApp();
    await import('../../../packages/server/src/ui/execution/entry.js');
    await vi.advanceTimersByTimeAsync(0);
    app.ontoolresult?.(runningEnvelope);
    await vi.advanceTimersByTimeAsync(0);
    const button = document.querySelector('button') as HTMLButtonElement;
    app.callServerTool.mockResolvedValueOnce({ content: [{ type: 'text', text: JSON.stringify({ taskId: 'task-1', status: 'running', cancellationRequested: true }) }] });
    button.click();
    await Promise.resolve();
    expect(button.disabled).toBe(true); // resolution of mma_task_cancel alone does not re-enable it
    app.ontoolresult?.({ content: [{ type: 'text', text: JSON.stringify({ taskId: 'task-1', status: 'running', phase: 'execute', elapsedMs: 1, phaseElapsedMs: 1, startedAt: '2026-01-01T00:00:00.000Z', cancellationRequested: true }) }] });
    expect(document.body.textContent).toMatch(/cancelling/i);
  });

  /**
   * A malformed FIRST delivery must not permanently disable the monitor.
   *
   * The initiating branch is what extracts the taskId and starts the poll loop; every later
   * delivery takes the update path, which does neither. So if the "we've been initiated"
   * latch is set before the payload is known to be good, one unparseable first message leaves
   * the App alive but inert — connected, rendering, and polling nothing, forever. It is a
   * silent failure: nothing throws, and the view looks like a task that simply never
   * progresses.
   */
  it('recovers when the FIRST delivery is unparseable and a later one is valid', async () => {
    const { app } = installMockApp();
    await import('../../../packages/server/src/ui/execution/entry.js');
    await Promise.resolve();

    app.ontoolresult?.({ content: [{ type: 'text', text: 'not json at all' }] });
    await Promise.resolve();
    expect(callsOf(app)).toHaveLength(0);
    expect(document.body.textContent).toMatch(/update failed/i);

    app.ontoolresult?.(runningEnvelope);
    await Promise.resolve();
    expect(callsOf(app)).toContainEqual({ name: 'mma_task_get', arguments: { taskId: 'task-1' } });
  });

  /**
   * Caught by the manual Claude Desktop gate, invisible to every automated test before it:
   * a bare `var(--color-text-primary)` is invalid at computed-value time on a host that does
   * not define it, so the App rendered initial-black on a dark panel in the default serif
   * face. jsdom computes no cascade and has no theme, so nothing here could have seen it.
   */
  it('every themed custom property carries a fallback, so an untheming host stays legible', async () => {
    installMockApp();
    await import('../../../packages/server/src/ui/execution/entry.js');
    await Promise.resolve();
    const root = document.getElementById('app')!;
    const style = root.getAttribute('style') ?? '';
    expect(style).toMatch(/var\(--color-text-primary,[^)]+\)/);
    expect(style).toMatch(/var\(--font-sans,[^)]+\)/);

    // The stylesheet must do the same for every HOST-provided property. Our own `--mma-*`
    // properties are exempt: they are defined in that same file, so a fallback would be dead
    // code. Only properties we do not control can go undefined at runtime.
    const html = await readFile('packages/server/src/ui/execution/execution.html', 'utf8');
    const hostVars = html.match(/var\(--(?!mma-)[a-z-]+\)/g) ?? [];
    expect(hostVars, `host properties used without a fallback: ${hostVars.join(', ')}`).toEqual([]);

    // And the readable default must flip with the host's colour scheme, since a single fixed
    // ink is unreadable against one of the two backgrounds by definition.
    expect(html).toMatch(/prefers-color-scheme:\s*dark/);
    expect(html).toMatch(/--mma-ink:/);
  });

  it('omits the phase lines entirely when a snapshot carries no phase yet', async () => {
    const { app } = installMockApp();
    await import('../../../packages/server/src/ui/execution/entry.js');
    await Promise.resolve();
    app.ontoolresult?.({ content: [{ type: 'text', text: JSON.stringify({
      taskId: 'task-1', status: 'running', elapsedMs: 0, phaseElapsedMs: 0,
    }) }] });
    await Promise.resolve();
    // A dangling "Phase:" with nothing after it is the FIRST thing a user sees on a new run,
    // and it reads as a failure to load rather than as "not started yet".
    expect(document.body.textContent).not.toMatch(/Phase:\s*(?:$|Elapsed)/m);
    expect(document.body.textContent).toMatch(/Running/);
  });

  it('formats elapsed time for humans rather than raw milliseconds', async () => {
    const { app } = installMockApp();
    await import('../../../packages/server/src/ui/execution/entry.js');
    await Promise.resolve();
    app.ontoolresult?.({ content: [{ type: 'text', text: JSON.stringify({
      taskId: 'task-1', status: 'running', phase: 'implementing', elapsedMs: 1_847_293, phaseElapsedMs: 7065,
    }) }] });
    await Promise.resolve();
    const text = document.body.textContent ?? '';
    expect(text).toContain('30m 47s');
    expect(text).toContain('7.1s');
    expect(text).not.toContain('1847293');
  });

});
/**
 * The widget is a MONITOR, not a result viewer.
 *
 * MMA results routinely run to thousands of characters, and the full text is ALREADY delivered
 * to the model as the tool result — rendering it again in the panel is duplication that turned
 * the monitor into a wall of raw JSON overflowing its container. These tests pin the terminal
 * view to: what happened, what it cost, and a short preview.
 */
describe('contract: terminal view reports run stats, not results', () => {
  beforeEach(() => { document.body.innerHTML = '<main id="app"></main>'; vi.resetModules(); });

  async function renderTerminal(envelope: Record<string, unknown>) {
    const { app } = installMockApp();
    await import('../../../packages/server/src/ui/execution/entry.js');
    await Promise.resolve();
    app.ontoolresult?.({ content: [{ type: 'text', text: JSON.stringify(envelope) }] });
    await Promise.resolve();
    return document.body.textContent ?? '';
  }

  /** Shaped from a real terminal envelope pulled out of the execution store. */
  const realish = {
    task: { taskId: 't1', status: 'done' },
    metrics: {
      totalDurationMs: 505782,
      totalCostUsd: 2.08677645,
      savedVsMainCostUsd: -0.08452670000000007,
      implementer: { durationMs: 281986, costUsd: 1.49031 },
      reviewer: { durationMs: 223758, costUsd: 0.59646645 },
      totalUsage: { inputTokens: 229045, outputTokens: 37007, cachedReadTokens: 2864079, cachedNonReadTokens: 63405 },
    },
    output: { summary: { answer: 'A'.repeat(4000) }, filesChanged: ['a.ts', 'b.ts'] },
  };

  it('shows no result text at all, however long the answer', async () => {
    const text = await renderTerminal(realish);
    // The conversation already carries the full answer directly below this panel. A truncated
    // copy is redundant AND reframes the monitor as a result card, which is not its job.
    expect(text).not.toContain('AAAA');
    expect(text).not.toMatch(/Full result/);
  });

  it('reports duration, cost and the per-stage split', async () => {
    const text = await renderTerminal(realish);
    expect(text).toContain('8m 25s');       // total duration
    expect(text).toContain('$2.09');        // total cost
    expect(text).toContain('Implementer');  // the split is the actionable part: a run where
    expect(text).toContain('Reviewer');     // the reviewer burns the budget is a tuning signal
    expect(text).toContain('$1.49');
    expect(text).toContain('$0.60');
  });

  it('states honestly when a run cost MORE than doing it on main', async () => {
    const text = await renderTerminal(realish);
    // Hiding a negative saving would make this panel marketing rather than instrumentation.
    expect(text).toContain('Over main');
    expect(text).toContain('$0.08');
    expect(text).not.toMatch(/\$-/);
  });

  it('names cached tokens separately instead of folding them into the input total', async () => {
    const text = await renderTerminal(realish);
    // 2.9M of 3.1M input-side tokens were cache reads. A combined figure reads as enormous
    // usage when it is mostly the cheap path.
    expect(text).toContain('229K in');
    expect(text).toContain('37K out');
    expect(text).toContain('2.9M cached');
  });

  it('reports files changed when the route wrote any', async () => {
    expect(await renderTerminal(realish)).toContain('Files changed');
  });

  it('renders a bare error envelope without empty rows or placeholders', async () => {
    const text = await renderTerminal({
      task: { taskId: 't1', status: 'failed' },
      metrics: { totalDurationMs: 0, totalCostUsd: 0, implementer: null, reviewer: null, totalUsage: null, savedVsMainCostUsd: null },
      output: { summary: null, filesChanged: [] },
    });
    expect(text).toContain('failed');
    expect(text).not.toContain('Implementer');
    expect(text).not.toContain('Tokens');
    expect(text).not.toContain('Files changed');
    expect(text).not.toMatch(/undefined|NaN|—/);
  });

  it('formats money for reading, not raw floats', async () => {
    const text = await renderTerminal({
      task: { taskId: 't1', status: 'done' },
      metrics: { totalCostUsd: 0.0021 },
    });
    expect(text).toContain('$0.0021'); // sub-cent amounts stay meaningful
  });
});
