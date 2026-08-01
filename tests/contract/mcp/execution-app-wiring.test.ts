// @vitest-environment jsdom
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

  it('consumes host CSS variables --color-text-primary and --font-sans instead of fixed colours', async () => {
    installMockApp();

    await import('../../../packages/server/src/ui/execution/entry.js');
    await Promise.resolve();
    const root = document.getElementById('app')!;
    const styling = (root.getAttribute('style') ?? '') + root.innerHTML;
    expect(styling).toMatch(/var\(--color-text-primary\)/);
    expect(styling).toMatch(/var\(--font-sans\)/);
  });
});