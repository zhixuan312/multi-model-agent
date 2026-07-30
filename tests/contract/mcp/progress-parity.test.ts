import { boot } from '../fixtures/harness.js';
import { mockProvider } from '../fixtures/mock-providers.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function runningPayload(headline: string | null) {
  const h = await boot({ provider: mockProvider({ stage: 'hang' }), cwd: process.cwd() });
  const response = await fetch(`${h.baseUrl}/task?cwd=${encodeURIComponent(process.cwd())}`, {
    method: 'POST', headers: { Authorization: `Bearer ${h.token}`, 'X-MMA-Client': 'claude-code', 'X-MMA-Main-Model': 'test', 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'investigate', prompt: 'wait' }),
  });
  const { taskId } = await response.json() as { taskId: string };
  const registry = h.taskRegistry;
  if (headline !== null) registry.setHeadline(taskId, headline);
  const rest = await fetch(`${h.baseUrl}/task/${taskId}`, { headers: { Authorization: `Bearer ${h.token}`, 'X-MMA-Client': 'claude-code', 'X-MMA-Main-Model': 'test' } });
  const client = new Client({ name: 'parity', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${h.baseUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${h.token}` } } }));
  const result = await client.callTool({ name: 'mma_task_get', arguments: { taskId } });
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
});
