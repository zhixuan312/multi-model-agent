import { boot } from '../fixtures/harness.js';
import { mockProvider } from '../fixtures/mock-providers.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function runningPayload(headline: string | null, body: Record<string, unknown> = { type: 'investigate', prompt: 'wait' }) {
  const h = await boot({ provider: mockProvider({ stage: 'hang' }), cwd: process.cwd() });
  const response = await fetch(`${h.baseUrl}/execution?cwd=${encodeURIComponent(process.cwd())}`, {
    method: 'POST', headers: { Authorization: `Bearer ${h.token}`, 'X-MMA-Client': 'claude-code', 'X-MMA-Main-Model': 'test', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const { executionId } = await response.json() as { executionId: string };
  const registry = h.executionRegistry;
  if (headline !== null) registry.setHeadline(executionId, headline);
  const rest = await fetch(`${h.baseUrl}/execution/${executionId}`, { headers: { Authorization: `Bearer ${h.token}`, 'X-MMA-Client': 'claude-code', 'X-MMA-Main-Model': 'test' } });
  const client = new Client({ name: 'parity', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${h.baseUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${h.token}` } } }));
  const result = await client.callTool({ name: 'mma_execution_get', arguments: { executionId } });
  // Narrow the SDK's union-typed content array first, matching the convention in
  // the existing tests/contract/mcp/ suite.
  const content = (result as { content: Array<{ type: 'text'; text: string }> }).content;
  return { h, client, rest: await rest.json() as Record<string, unknown>, mcp: JSON.parse(content[0]!.text) as Record<string, unknown> };
}

describe('contract: running progress parity', () => {
  it('keeps every running field and non-null headline identical across wires', async () => {
    const x = await runningPayload('Writing the contract tests');
    try {
      expect(new Set(Object.keys(x.mcp))).toEqual(new Set(Object.keys(x.rest)));
      expect(x.rest.runningHeadline).toBe('Writing the contract tests');
      expect(x.mcp.runningHeadline).toBe(x.rest.runningHeadline);
      expect(x.mcp.phaseElapsedMs).toEqual(expect.any(Number));
    } finally { await x.client.close(); await x.h.close(); }
  });

  it('omits a null headline from both otherwise-identical running payloads', async () => {
    const x = await runningPayload(null);
    try {
      expect(x.rest).not.toHaveProperty('runningHeadline');
      expect(x.mcp).not.toHaveProperty('runningHeadline');
      expect(new Set(Object.keys(x.mcp))).toEqual(new Set(Object.keys(x.rest)));
    } finally { await x.client.close(); await x.h.close(); }
  });

  /**
   * A running task used to identify itself only by UUID: `phase` is `implementing` for a
   * spec, a review and an investigation alike, so nothing on the wire said which one was
   * running. The type was in the registry the whole time and read only to gate
   * `totalTasks`.
   */
  it('names the task type and project on the running payload, on both wires', async () => {
    const x = await runningPayload(null);
    try {
      expect(x.rest.type).toBe('investigate');
      expect(x.mcp.type).toBe('investigate');
      expect(x.rest.cwd).toBe(x.mcp.cwd);
      expect(typeof x.mcp.cwd).toBe('string');
      // No subtype on a non-audit type — absent, not null.
      expect(x.rest).not.toHaveProperty('subtype');
      expect(x.mcp).not.toHaveProperty('subtype');
    } finally { await x.client.close(); await x.h.close(); }
  });

  /**
   * SPEC-005: `method` is a wire field on the running payload, carried identically on both
   * wires for every task type — including when the caller requested a resolved Method.
   * `investigate` above (no requested Method) still carries neither `subtype` nor a
   * non-null `method` — this test covers the resolved-Method case, using a `debug` task
   * that DID request one.
   */
  it('carries a requested method identically across both wires, alongside no subtype', async () => {
    const x = await runningPayload(null, { type: 'debug', prompt: 'wait', method: 'software-change@1' });
    try {
      expect(x.rest.type).toBe('debug');
      expect(x.mcp.type).toBe('debug');
      expect(x.rest.method).toBe('software-change@1');
      expect(x.mcp.method).toBe('software-change@1');
      expect(x.rest).not.toHaveProperty('subtype');
      expect(x.mcp).not.toHaveProperty('subtype');
      expect(new Set(Object.keys(x.mcp))).toEqual(new Set(Object.keys(x.rest)));
    } finally { await x.client.close(); await x.h.close(); }
  });
});
