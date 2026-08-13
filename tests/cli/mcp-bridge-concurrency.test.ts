import { describe, it, expect } from 'vitest';
import { runMcpBridge } from '../../packages/server/src/cli/mcp.js';

/**
 * The bridge must forward frames CONCURRENTLY.
 *
 * It used to process stdin strictly one frame at a time. That is fine until a call
 * legitimately blocks: `mma_execution_wait` holds its response for up to 55s server-side, and a
 * sequential bridge made every LATER frame wait behind it — including the execution App's
 * own `mma_execution_get` polls. The App's per-poll timeout then fired and it rendered
 * "update failed — showing last known state" while the daemon was perfectly healthy. The
 * long-poll starved the very monitor that exists to show progress during long polls.
 *
 * Observed on Claude Desktop as: one `POST /mcp 200 55097ms` immediately followed by a burst
 * of 1-3ms polls that had been queued behind it.
 *
 * JSON-RPC multiplexes on `id`, so out-of-order completion is correct and the host correlates
 * responses itself. These tests pin that behaviour: a slow frame must not delay a fast one,
 * and every accepted frame must still be answered.
 */

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function sse(payload: unknown): Response {
  return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

const frame = (id: number, method: string) =>
  JSON.stringify({ jsonrpc: '2.0', id, method, params: {} });

describe('mma mcp bridge — concurrent frame forwarding', () => {
  it('answers a fast frame while a slow one is still in flight', async () => {
    const slow = deferred<Response>();
    const order: number[] = [];
    const stdout: string[] = [];

    // Frame 1 blocks (the long mma_execution_wait); frames 2 and 3 are quick polls.
    const code = await runMcpBridge({
      daemonUrl: 'http://127.0.0.1:7337',
      env: { MMA_AUTH_TOKEN: 'SENTINEL' },
      homeDir: '/unused',
      stdin: (async function* () {
        yield frame(1, 'tools/call');
        yield frame(2, 'tools/call');
        yield frame(3, 'tools/call');
        // Give the fast frames a chance to complete before the slow one is released; if the
        // bridge were sequential, nothing at all would have been written by now.
        await new Promise((r) => setTimeout(r, 20));
        expect(stdout.length, 'fast frames must complete while frame 1 blocks').toBeGreaterThan(0);
        slow.resolve(sse({ jsonrpc: '2.0', id: 1, result: { slow: true } }));
      })(),
      stdout: (s) => { stdout.push(s); order.push(JSON.parse(s).id as number); return true; },
      stderr: () => true,
      readFile: () => { throw new Error('unexpected token file read'); },
      resolveHost: async () => [{ address: '127.0.0.1' }],
      fetch: (async (url: string, init?: RequestInit) => {
        if (new URL(url).pathname === '/health') return new Response('{"status":"ok"}', { status: 200 });
        const id = (JSON.parse(String(init?.body)) as { id: number }).id;
        if (id === 1) return slow.promise;
        return sse({ jsonrpc: '2.0', id, result: { fast: true } });
      }) as unknown as typeof fetch,
    });

    expect(code).toBe(0);
    // Every frame answered, and the slow one came LAST despite being sent FIRST.
    expect(order.sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(stdout).toHaveLength(3);
  });

  it('waits for in-flight forwards to finish after stdin closes', async () => {
    const pending = deferred<Response>();
    const stdout: string[] = [];

    const run = runMcpBridge({
      daemonUrl: 'http://127.0.0.1:7337',
      env: { MMA_AUTH_TOKEN: 'SENTINEL' },
      homeDir: '/unused',
      // stdin ends IMMEDIATELY after the frame — the response has not arrived yet.
      stdin: (async function* () { yield frame(7, 'tools/call'); })(),
      stdout: (s) => { stdout.push(s); return true; },
      stderr: () => true,
      readFile: () => { throw new Error('unexpected token file read'); },
      resolveHost: async () => [{ address: '127.0.0.1' }],
      fetch: (async (url: string) => {
        if (new URL(url).pathname === '/health') return new Response('{"status":"ok"}', { status: 200 });
        return pending.promise;
      }) as unknown as typeof fetch,
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(stdout, 'nothing written yet — the forward is still in flight').toHaveLength(0);
    pending.resolve(sse({ jsonrpc: '2.0', id: 7, result: { ok: true } }));

    // A client that closes the pipe promptly must still receive the answer it is owed.
    expect(await run).toBe(0);
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0]!).id).toBe(7);
  });
});
