// @vitest-environment jsdom
import { readFile } from 'node:fs/promises';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * AC-3.5 — the execution App reaches the server ONLY through `app.callServerTool`.
 *
 * The App runs inside the host's iframe with no MMA credential of its own: the daemon token
 * lives in the host process, and every privileged action is brokered by the host over the
 * MCP channel. So the property under test is not "the App uses the right token" — it is that
 * the App never opens a channel of its OWN, by any means, and never reads or writes browser
 * credential storage.
 *
 * Two things make this a real proof rather than a gesture:
 *
 *  1. Instrumentation is installed BEFORE the module is imported, so it also covers calls
 *     made transitively from inside `@modelcontextprotocol/ext-apps` — not only MMA's code.
 *  2. The first poll resolves NON-terminal, so the Cancel path actually executes. With a
 *     terminal first poll the App stops immediately and a leak in cancellation code would
 *     ship undetected — the test would pass by never running the code it exists to check.
 */

const ALLOWED_TOOLS = ['mma_execution_get', 'mma_execution_cancel'];

function installMockAppFullCycle() {
  const app = {
    connect: vi.fn().mockResolvedValue(undefined),
    ontoolresult: undefined as ((v: unknown) => void) | undefined,
    callServerTool: vi.fn()
      .mockResolvedValueOnce({ content: [{ type: 'text', text: JSON.stringify({
        executionId: 't1', status: 'running', phase: 'execute', elapsedMs: 10, phaseElapsedMs: 10, startedAt: '2026-01-01T00:00:00.000Z',
      }) }] })
      .mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify({
        execution: { executionId: 't1', status: 'done' }, metrics: { totalCostUsd: 0.1, savedVsMainCostUsd: 0.2 }, output: { summary: 'ok' },
      }) }] }),
  };
  (window as unknown as { __MMA_CREATE_APP__: () => typeof app }).__MMA_CREATE_APP__ = () => app;
  return app;
}

describe('contract: execution App credential and network safety (AC-3.5)', () => {
  /** Every egress channel a browser page has, and every credential store it can touch. */
  let egress: Record<string, ReturnType<typeof vi.fn>>;
  let cookieReads: number;
  let cookieWrites: string[];
  const restores: Array<() => void> = [];

  /**
   * Replace a global with a recording stub, remembering how to put it back. Assigning the
   * property directly (rather than `vi.spyOn`) is deliberate: several of these — sendBeacon,
   * indexedDB — do not exist in jsdom at all, so there is nothing to spy ON. A test that
   * only spied on what jsdom happens to implement would silently skip those channels.
   */
  function stub(target: object, key: string, value: unknown): void {
    const had = Object.prototype.hasOwnProperty.call(target, key);
    const previous = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { value, configurable: true, writable: true });
    restores.push(() => {
      if (had && previous) Object.defineProperty(target, key, previous);
      else delete (target as Record<string, unknown>)[key];
    });
  }

  beforeEach(() => {
    document.body.innerHTML = '<main id="app"></main>';
    vi.resetModules();
    cookieReads = 0;
    cookieWrites = [];

    egress = {
      fetch: vi.fn(() => { throw new Error('network call attempted: fetch'); }),
      XMLHttpRequest: vi.fn(() => { throw new Error('network call attempted: XMLHttpRequest'); }),
      WebSocket: vi.fn(() => { throw new Error('network call attempted: WebSocket'); }),
      EventSource: vi.fn(() => { throw new Error('network call attempted: EventSource'); }),
      sendBeacon: vi.fn(() => { throw new Error('network call attempted: sendBeacon'); }),
      indexedDB_open: vi.fn(() => { throw new Error('credential storage touched: indexedDB'); }),
    };

    stub(globalThis, 'fetch', egress.fetch);
    stub(window, 'fetch', egress.fetch);
    stub(window, 'XMLHttpRequest', egress.XMLHttpRequest);
    stub(window, 'WebSocket', egress.WebSocket);
    stub(window, 'EventSource', egress.EventSource);
    stub(window.navigator, 'sendBeacon', egress.sendBeacon);
    stub(window, 'indexedDB', { open: egress.indexedDB_open });

    // document.cookie is an accessor, so it needs a getter/setter rather than a value.
    const cookieDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      get: () => { cookieReads += 1; return ''; },
      set: (v: string) => { cookieWrites.push(v); },
    });
    restores.push(() => {
      delete (document as unknown as Record<string, unknown>).cookie;
      if (cookieDescriptor) Object.defineProperty(Document.prototype, 'cookie', cookieDescriptor);
    });
  });

  afterEach(() => {
    while (restores.length > 0) restores.pop()!();
    vi.restoreAllMocks();
  });

  it('performs every server interaction through app.callServerTool and touches no network or storage API', async () => {
    // A dynamic import is the one channel the stubs above cannot intercept, because it would
    // resolve a fresh module graph after instrumentation is in place.
    const entrySource = await readFile('packages/server/src/ui/execution/entry.ts', 'utf8');
    expect(entrySource).not.toMatch(/\bimport\s*\(/);

    const storageGet = vi.spyOn(Storage.prototype, 'getItem');
    const storageSet = vi.spyOn(Storage.prototype, 'setItem');

    const app = installMockAppFullCycle();
    await import('../../../packages/server/src/ui/execution/entry.js');
    await Promise.resolve();

    app.ontoolresult?.({ content: [{ type: 'text', text: JSON.stringify({
      executionId: 't1', status: 'running', phase: 'execute', elapsedMs: 1, phaseElapsedMs: 1, startedAt: '2026-01-01T00:00:00.000Z',
    }) }] });
    await Promise.resolve();
    await Promise.resolve();

    // Assert the button EXISTS before clicking. `button?.click()` would let this whole test
    // pass by doing nothing at all if the Cancel affordance regressed away.
    const button = document.querySelector('button');
    expect(button, 'Cancel button must be rendered for a running task').not.toBeNull();
    expect((button as HTMLButtonElement).disabled).toBe(false);
    (button as HTMLButtonElement).click();
    await Promise.resolve();

    // The cancel path RAN — not merely "some call happened".
    const calls = app.callServerTool.mock.calls.map(([c]) => c as { name: string; arguments: Record<string, unknown> });
    expect(calls).toContainEqual({ name: 'mma_execution_cancel', arguments: { executionId: 't1' } });
    expect(calls.some((c) => c.name === 'mma_execution_get')).toBe(true);

    // …and nothing outside the brokered channel was used.
    for (const [name, spy] of Object.entries(egress)) {
      expect(spy, `${name} must never be used`).not.toHaveBeenCalled();
    }
    expect(storageGet, 'localStorage/sessionStorage read').not.toHaveBeenCalled();
    expect(storageSet, 'localStorage/sessionStorage write').not.toHaveBeenCalled();
    expect(cookieReads, 'document.cookie read').toBe(0);
    expect(cookieWrites, 'document.cookie write').toEqual([]);

    // Every tool the App invokes is one of the two it is allowed to invoke. A new call added
    // later — say a token-refresh helper — fails here rather than passing as "not fetch".
    for (const call of calls) {
      expect(ALLOWED_TOOLS, `unexpected server tool: ${call.name}`).toContain(call.name);
    }
  });
});
