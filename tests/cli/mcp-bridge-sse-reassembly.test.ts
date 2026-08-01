import { describe, it, expect } from 'vitest';
import { runMcpBridge } from '../../packages/server/src/cli/mcp.js';

/**
 * SSE payload reassembly.
 *
 * A producer splits a payload across several `data:` lines precisely BECAUSE the
 * payload itself contains newlines — a pretty-printed JSON document, for instance —
 * and the receiver reconstructs it by rejoining those lines with '\n', per the SSE
 * specification. These tests therefore split on the payload's OWN newlines, which is
 * what a real producer emits.
 *
 * They deliberately do NOT split at arbitrary byte offsets. That would land mid-token
 * or mid-string, and rejoining with '\n' — the join the spec mandates — would yield
 * invalid JSON. No SSE producer can emit such a stream, so a test asserting it would
 * force the receiver into plain concatenation and silently corrupt every payload whose
 * own newlines are significant. (An earlier revision of this file did exactly that,
 * and the implementation was written to match it.)
 */
function sse(payload: unknown, pretty: boolean): string {
  const encoded = pretty ? JSON.stringify(payload, null, 2) : JSON.stringify(payload);
  const dataLines = encoded.split('\n').map((line) => `data: ${line}`).join('\n');
  return `event: message\n${dataLines}\n\n`;
}

async function forwardOne(body: string): Promise<string[]> {
  const stdout: string[] = [];
  const code = await runMcpBridge({
    daemonUrl: 'http://127.0.0.1:7337',
    env: { MMA_AUTH_TOKEN: 'SENTINEL' },
    homeDir: '/unused',
    stdin: (async function* () { yield JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }); })(),
    stdout: (s) => { stdout.push(s); return true; },
    stderr: () => true,
    readFile: () => { throw new Error('unexpected token file read'); },
    resolveHost: async () => [{ address: '127.0.0.1' }],
    fetch: (async (url: string) => {
      if (new URL(url).pathname === '/health') return new Response('{"status":"ok"}', { status: 200 });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch,
  });
  expect(code).toBe(0);
  return stdout;
}

describe('mma mcp bridge — multi-line SSE reassembly', () => {
  it('reassembles a payload whose own newlines split it across several data: lines', async () => {
    const payload = { jsonrpc: '2.0', id: 1, result: { ok: true, nested: { a: 1, b: [1, 2, 3] } } };
    const stdout = await forwardOne(sse(payload, true));
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0]!)).toEqual(payload);
  });

  it('is unchanged for the single-line case the daemon actually emits today', async () => {
    const payload = { jsonrpc: '2.0', id: 1, result: { tools: ['mma_run'] } };
    const stdout = await forwardOne(sse(payload, false));
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0]!)).toEqual(payload);
  });

  it('round-trips a >100KB payload — a resources/read reply carrying an inlined bundle', async () => {
    const html = `<!doctype html><style>${'a{color:red}'.repeat(9000)}</style>`;
    const payload = { jsonrpc: '2.0', id: 1, result: { contents: [{ uri: 'ui://mma/execution.html', text: html }] } };
    expect(JSON.stringify(payload).length).toBeGreaterThan(100_000);
    const stdout = await forwardOne(sse(payload, true));
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0]!)).toEqual(payload);
  });

  it('drops exactly ONE leading space per data line, preserving significant whitespace', async () => {
    // Per the SSE spec a field value loses exactly one leading space after the colon.
    // A full trim would corrupt indented content — including the pretty-printed bodies above.
    const payload = { jsonrpc: '2.0', id: 1, result: { text: '   three leading spaces' } };
    const stdout = await forwardOne(sse(payload, true));
    expect((JSON.parse(stdout[0]!) as typeof payload).result.text).toBe('   three leading spaces');
  });
});
