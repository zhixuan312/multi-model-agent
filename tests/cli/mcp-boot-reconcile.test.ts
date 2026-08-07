import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecutionStore } from '../../packages/server/src/application/execution-store.js';
import { reconcileOnBoot } from '../../packages/server/src/application/reconcile.js';
import { runMcpBridge } from '../../packages/server/src/cli/mcp.js';

function lines(values: string[]): AsyncIterable<string> {
  return (async function* () { yield* values; })();
}

it('cannot reach a dead-daemon stranded row via the bridge; the next boot reconciles it and unblocks the bridge', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'mma-mcp-reconcile-'));
  const dbPath = join(stateDir, 'executions.db');
  const seeded = new ExecutionStore({ dbPath, ttlMs: 60_000 });
  seeded.admit('stranded', 'investigate', '/repo', 999_999_999); // dead daemon pid
  seeded.close();

  try {
    // 1. While no daemon is alive, the bridge's own fatal health preflight
    //    refuses to run — it cannot see or touch the stranded row.
    const beforeStdout: string[] = [];
    const beforeCode = await runMcpBridge({
      daemonUrl: 'http://localhost:7337', env: { MMA_AUTH_TOKEN: 'token' }, homeDir: '/unused',
      stdin: lines(['{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n']),
      stdout: (s) => { beforeStdout.push(s); return true; }, stderr: () => true,
      resolveHost: async () => [{ address: '127.0.0.1' }], readFile: () => 'unused',
      fetch: (async () => new Response('unhealthy', { status: 503 })) as unknown as typeof fetch,
    });
    expect(beforeCode).not.toBe(0);
    expect(beforeStdout).toHaveLength(0);
    const stillPending = new ExecutionStore({ dbPath, ttlMs: 60_000 });
    expect(stillPending.get('stranded')!.state).toBe('pending');
    stillPending.close();

    // 2. A daemon boot runs the exact function startServer runs before
    //    accepting requests.
    const bootStore = new ExecutionStore({ dbPath, ttlMs: 60_000 });
    expect(reconcileOnBoot(bootStore)).toMatchObject({ interrupted: 1 });
    const record = bootStore.get('stranded')!;
    expect(record.state).toBe('interrupted');
    expect(JSON.parse(record.resultJson!)).toMatchObject({ error: { code: 'daemon_restarted', retryable: true } });
    bootStore.close();

    // 3. Now that a daemon is live and reconciled, the bridge's health
    //    preflight succeeds and frames forward normally.
    const afterStdout: string[] = [];
    const afterCode = await runMcpBridge({
      daemonUrl: 'http://localhost:7337', env: { MMA_AUTH_TOKEN: 'token' }, homeDir: '/unused',
      stdin: lines(['{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n']),
      stdout: (s) => { afterStdout.push(s); return true; }, stderr: () => true,
      resolveHost: async () => [{ address: '127.0.0.1' }], readFile: () => 'unused',
      fetch: (async (url: string) => {
        if (new URL(url).pathname === '/health') return new Response('{"status":"ok"}', { status: 200 });
        return new Response('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n', {
          status: 200, headers: { 'content-type': 'text/event-stream' },
        });
      }) as unknown as typeof fetch,
    });
    expect(afterCode).toBe(0);
    expect(afterStdout.map((s) => JSON.parse(s))).toEqual([{ jsonrpc: '2.0', id: 1, result: {} }]);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});