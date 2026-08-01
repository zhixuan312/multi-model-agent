import { describe, it, expect } from 'vitest';
import { runMcpBridge } from '../../packages/server/src/cli/mcp.js';

function lines(values: string[]): AsyncIterable<string> {
  return (async function* () { yield* values; })();
}

describe('mma mcp bridge — multi-line SSE reassembly', () => {
  it('parses a payload split across several data: lines identically to a single-line one', async () => {
    const payload = { jsonrpc: '2.0', id: 1, result: { ok: true, nested: { a: 1, b: [1, 2, 3] } } };
    const encoded = JSON.stringify(payload);
    const third = Math.ceil(encoded.length / 3);
    const chunks = [encoded.slice(0, third), encoded.slice(third, third * 2), encoded.slice(third * 2)];
    const stdout: string[] = [];
    const code = await runMcpBridge({
      daemonUrl: 'http://127.0.0.1:7337', env: { MMA_AUTH_TOKEN: 'SENTINEL' }, homeDir: '/unused',
      stdin: lines(['{"jsonrpc":"2.0","id":1,"method":"resources/read","params":{"uri":"ui://mma/execution.html"}}\n']),
      stdout: (s) => { stdout.push(s); return true; }, stderr: () => true,
      readFile: () => { throw new Error('unexpected token file read'); }, resolveHost: async () => [],
      fetch: (async (url: string) => {
        if (url.endsWith('/health')) return new Response('{"status":"ok"}', { status: 200 });
        const body = `event: message\n${chunks.map((c) => `data: ${c}`).join('\n')}\n\n`;
        return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }) as typeof fetch,
    });
    expect(code).toBe(0);
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0]!)).toEqual(payload);
  });

  it('preserves a >100 KB resources/read reply through the bridge with no truncation', async () => {
    const hugeHtml = `<html>${'x'.repeat(120_000)}</html>`;
    const payload = { jsonrpc: '2.0', id: 7, result: { contents: [{ uri: 'ui://mma/execution.html', mimeType: 'text/html;profile=mcp-app', text: hugeHtml }] } };
    const encoded = JSON.stringify(payload);
    const split = Math.floor(encoded.length / 2);
    const stdout: string[] = [];
    const code = await runMcpBridge({
      daemonUrl: 'http://127.0.0.1:7337', env: { MMA_AUTH_TOKEN: 'SENTINEL' }, homeDir: '/unused',
      stdin: lines(['{"jsonrpc":"2.0","id":7,"method":"resources/read","params":{"uri":"ui://mma/execution.html"}}\n']),
      stdout: (s) => { stdout.push(s); return true; }, stderr: () => true,
      readFile: () => { throw new Error('unexpected'); }, resolveHost: async () => [],
      fetch: (async (url: string) => {
        if (url.endsWith('/health')) return new Response('{"status":"ok"}', { status: 200 });
        return new Response(`event: message\ndata: ${encoded.slice(0, split)}\ndata: ${encoded.slice(split)}\n\n`, { status: 200 });
      }) as typeof fetch,
    });
    expect(code).toBe(0);
    expect(stdout).toHaveLength(1);
    expect(stdout[0]!.length).toBeGreaterThan(100_000);
    expect(JSON.parse(stdout[0]!)).toEqual(payload);
  });
});