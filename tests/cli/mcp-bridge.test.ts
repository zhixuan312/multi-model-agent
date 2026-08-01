import { runMcpBridge } from '../../packages/server/src/cli/mcp.js';

function lines(values: string[]): AsyncIterable<string> {
  return (async function* () { yield* values; })();
}

describe('mma mcp bridge', () => {
  it('pins the first numeric DNS answer for two frames and never leaks the token', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let lookups = 0;
    const code = await runMcpBridge({
      daemonUrl: 'http://localhost:7337', env: { MMA_AUTH_TOKEN: 'SENTINEL_TOKEN' }, homeDir: '/unused',
      stdin: lines([
        '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n',
        '{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n',
      ]),
      stdout: (s) => { stdout.push(s); return true; }, stderr: (s) => { stderr.push(s); return true; },
      resolveHost: async () => (++lookups === 1 ? [{ address: '127.0.0.1' }] : [{ address: '203.0.113.9' }]),
      readFile: () => { throw new Error('unexpected token file read'); },
      fetch: (async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (new URL(url).pathname === '/health') return new Response('{"status":"ok"}', { status: 200 });
        const id = calls.length - 1;
        return new Response(`event: message\ndata: {"jsonrpc":"2.0","id":${id},"result":{}}\n\n`, {
          status: 200, headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 'must-not-propagate' },
        });
      }) as typeof fetch,
    });
    expect(code).toBe(0);
    expect(lookups).toBe(1);
    expect(calls.map((call) => call.url)).toEqual([
      'http://127.0.0.1:7337/health',
      'http://127.0.0.1:7337/mcp',
      'http://127.0.0.1:7337/mcp',
    ]);
    // The forwarded request must actually carry the stdin frame. Without this,
    // a bridge that issues GET, or POSTs a fixed/empty body while ignoring
    // stdin entirely, would still satisfy every assertion above.
    const forwarded = calls.slice(1).map((call) => JSON.parse(String(call.init?.body)));
    expect(calls.slice(1).map((call) => call.init?.method)).toEqual(['POST', 'POST']);
    expect(forwarded.map((frame) => frame.id).sort()).toEqual([1, 2]);
    for (const frame of forwarded) {
      expect(frame).toEqual({ jsonrpc: '2.0', id: frame.id, method: 'tools/list' });
    }
    for (const call of calls.slice(1)) {
      expect(new Headers(call.init?.headers).get('authorization')).toBe('Bearer SENTINEL_TOKEN');
      expect(new Headers(call.init?.headers).get('host')).toBe('127.0.0.1');
      expect(new Headers(call.init?.headers).get('content-type')).toBe('application/json');
      expect(new Headers(call.init?.headers).get('accept')).toBe('application/json, text/event-stream');
      expect(new Headers(call.init?.headers).get('mcp-session-id')).toBeNull();
    }
    expect(stdout.map((s) => JSON.parse(s))).toEqual([
      { jsonrpc: '2.0', id: 1, result: {} }, { jsonrpc: '2.0', id: 2, result: {} },
    ]);
    expect(`${stdout.join('')}\n${stderr.join('')}`).not.toContain('SENTINEL_TOKEN');
  });

  it('rejects unsafe startup and continues after every recoverable frame failure', async () => {
    const unsafeErr: string[] = [];
    const unsafeCode = await runMcpBridge({
      daemonUrl: 'http://localhost:7337', env: { MMA_AUTH_TOKEN: 'secret' }, homeDir: '/unused', stdin: lines([]),
      stdout: () => true, stderr: (s) => { unsafeErr.push(s); return true; }, readFile: () => 'ignored',
      resolveHost: async () => [{ address: '198.51.100.5' }], fetch: vi.fn() as unknown as typeof fetch,
    });
    expect(unsafeCode).not.toBe(0);
    expect(unsafeErr.join('')).toMatch(/localhost.*198\.51\.100\.5/);

    const out: string[] = [];
    const err: string[] = [];
    let post = 0;
    const code = await runMcpBridge({
      daemonUrl: 'http://127.0.0.1:7337', env: { MMA_AUTH_TOKEN: 'SENTINEL_TOKEN' }, homeDir: '/unused',
      stdin: lines([
        'not json\n', '[]\n',
        '{"jsonrpc":"2.0","id":3,"method":"x"}\n',
        '{"jsonrpc":"2.0","id":4,"method":"x"}\n',
        '{"jsonrpc":"2.0","id":5,"method":"x"}\n',
        '{"jsonrpc":"2.0","method":"note"}\n',
      ]),
      stdout: (s) => { out.push(s); return true; }, stderr: (s) => { err.push(s); return true; },
      resolveHost: vi.fn(), readFile: () => 'ignored',
      // Keyed by frame ID, not by call order: frames are forwarded concurrently, so a
      // counter would hand each failure to whichever frame happened to win the race.
      fetch: (async (url: string, init?: RequestInit) => {
        if (url.endsWith('/health')) return new Response('', { status: 200 });
        post += 1;
        const id = (JSON.parse(String(init?.body)) as { id?: number }).id;
        if (id === 3) return new Response('upstream down', { status: 503 });
        if (id === 4) return new Response('broken SSE', { status: 200 });
        if (id === 5) throw new Error('daemon died: SENTINEL_TOKEN');
        return new Response('event: message\ndata: {"jsonrpc":"2.0","result":{}}\n\n', { status: 200 });
      }) as typeof fetch,
    });
    expect(code).toBe(0);
    // Compared as a SET. JSON-RPC correlates responses by `id`, so the bridge is free to
    // answer out of order — and now does, deliberately, so a slow frame cannot starve a fast
    // one. Asserting a fixed sequence here would be over-specifying the protocol.
    const byId = new Map(out.map((s) => { const f = JSON.parse(s) as { id: number | null }; return [String(f.id ?? `null-${out.indexOf(s)}`), f]; }));
    expect(out).toHaveLength(5);
    expect(out.map((s) => (JSON.parse(s) as { id: number | null }).id).sort()).toEqual([3, 4, 5, null, null].sort());
    expect(byId.get('3')).toMatchObject({ error: { code: -32603, data: { httpStatus: 503 } } });
    expect(byId.get('4')).toMatchObject({ error: { code: -32603 } });
    expect(byId.get('5')).toMatchObject({ error: { code: -32603 } });
    const nullFrames = out.map((s) => JSON.parse(s) as { id: null; error: { code: number } }).filter((f) => f.id === null);
    expect(nullFrames.map((f) => f.error.code).sort()).toEqual([-32700, -32600].sort());
    expect(err.join('')).toContain('mma serve');
    expect(`${out.join('')}\n${err.join('')}`).not.toContain('SENTINEL_TOKEN');
  });

  it('uses the documented token precedence and fails before health when every source is unusable', async () => {
    const auth: string[] = [];
    const common = {
      daemonUrl: 'http://127.0.0.1:7337', homeDir: '/home/a', stdin: lines(['{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n']), stdout: () => true, stderr: () => true,
      resolveHost: vi.fn(), fetch: (async (_url: string, init?: RequestInit) => { auth.push(new Headers(init?.headers).get('authorization') ?? ''); return new Response('', { status: 200 }); }) as typeof fetch,
    };
    await runMcpBridge({ ...common, env: { MMA_AUTH_TOKEN: 'env-token', MMA_TOKEN_FILE: '/token' }, readFile: () => 'file-token' });
    expect(auth).toEqual(['', 'Bearer env-token']);
    const callsBeforeMissingToken = auth.length;
    const diagnostics: string[] = [];
    const code = await runMcpBridge({ ...common, env: { MMA_AUTH_TOKEN: ' ', MMA_TOKEN_FILE: '/token' }, readFile: () => ' ', stderr: (s) => { diagnostics.push(s); return true; } });
    expect(code).not.toBe(0);
    expect(diagnostics.join('')).toMatch(/MMA_AUTH_TOKEN.*MMA_TOKEN_FILE.*auth-token/);
    expect(auth).toHaveLength(callsBeforeMissingToken);
  });
});