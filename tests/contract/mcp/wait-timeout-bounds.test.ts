import { describe, it, expect } from 'vitest';
import {
  MCP_TOOLS,
  WAIT_CAP_MS,
  WAIT_DEFAULT_MS,
  INLINE_WAIT_CAP_MS,
} from '../../../packages/server/src/mcp/tool-surface.js';

/**
 * A long-poll cannot outlive the deadline the CLIENT enforces on the request carrying it.
 *
 * `mma_execution_wait` advertised `capped at 240000` while typical MCP hosts abort a tool call
 * after ~60s. On Claude Desktop the model read that ceiling, asked for it, and got
 * `-32001 Request timed out` — no snapshot, no executionId context, no sign the execution was still
 * running perfectly well. The schema was inviting a request the transport could never
 * deliver.
 *
 * `INLINE_WAIT_CAP_MS` already encoded the correct bound with the correct reasoning ("below
 * typical MCP client tool timeouts"); the wait ceiling simply disagreed with it. These tests
 * bind the two together so they cannot drift apart again.
 */
describe('contract: mma_execution_wait timeout bounds fit inside client request deadlines', () => {
  it('caps the advertised wait at the same bound as the inline wait', () => {
    expect(WAIT_CAP_MS).toBe(INLINE_WAIT_CAP_MS);
  });

  it('stays under 60s, the deadline typical MCP hosts enforce on a single tool call', () => {
    expect(WAIT_CAP_MS).toBeLessThan(60_000);
    expect(WAIT_DEFAULT_MS).toBeLessThanOrEqual(WAIT_CAP_MS);
  });

  /**
   * The schema must NOT impose the ceiling, only document it.
   *
   * Capping in the schema turns an over-large request into a hard `-32602` validation error
   * before it ever reaches the server's clamp — observed on Claude Desktop, where the model
   * asked for 300000 and got a Zod `too_big` payload to decode instead of a wait. Asking to
   * wait "5 minutes" is a reasonable intent; the right answer is a 55s wait and a running
   * snapshot, not a schema violation.
   */
  it('documents the ceiling WITHOUT enforcing it, so large requests clamp instead of failing', () => {
    const wait = MCP_TOOLS.find((t) => t.name === 'mma_execution_wait');
    expect(wait).toBeDefined();
    const timeout = (wait!.inputSchema as {
      properties: { timeoutMs: { maximum?: number; minimum?: number; description: string } };
    }).properties.timeoutMs;
    expect(timeout.maximum, 'a schema maximum rejects instead of clamping').toBeUndefined();
    expect(timeout.minimum).toBe(1);
    expect(timeout.description).toContain(String(WAIT_CAP_MS));
    expect(timeout.description).toMatch(/clamp/i);
    expect(timeout.description).not.toContain('240000');
  });

  it('tells the model a timeout is not a failure, so it re-waits instead of giving up', () => {
    const wait = MCP_TOOLS.find((t) => t.name === 'mma_execution_wait')!;
    expect(wait.description).toMatch(/not an error|NOT an error/i);
    expect(wait.description).toMatch(/call again/i);
  });
});

/**
 * Proves the SERVER half: an over-large wait is accepted and clamped, not rejected.
 *
 * It deliberately does NOT claim to reproduce the Desktop failure, and cannot. Restoring the
 * rejecting `maximum` leaves this test green while the schema-shape test above goes red —
 * which is itself the finding: the `-32602` came from the HOST validating arguments against
 * the advertised schema before the request was ever sent. Nothing server-side can observe a
 * call the client refused to make, so the schema assertion above is the real guard here and
 * this one only shows the clamp behind it is sound.
 */
describe('contract: an over-large wait is clamped, not rejected', () => {
  it('accepts timeoutMs far above the cap and returns a running snapshot', async () => {
    const { boot } = await import('../fixtures/harness.js');
    const { mockProvider } = await import('../fixtures/mock-providers.js');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import(
      '@modelcontextprotocol/sdk/client/streamableHttp.js'
    );

    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    const client = new Client({ name: 'wait-clamp', version: '0.0.0' });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${h.baseUrl}/mcp`), {
          requestInit: { headers: { Authorization: `Bearer ${h.token}` } },
        })
      );
      const started = await client.callTool({
        name: 'mma_run',
        arguments: { cwd: process.cwd(), mode: 'handle', request: { type: 'investigate', prompt: 'x' } },
      });
      const handle = JSON.parse(
        ((started.content as Array<{ text: string }>)[0]!).text
      ) as { executionId?: string };
      // Assert rather than skip. An early `return` here made this test pass even with the
      // rejecting schema restored — it never reached the call it exists to make. A missing
      // executionId from mode:'handle' is itself a failure, not a reason to opt out.
      expect(handle.executionId, 'mode:handle must return an executionId to wait on').toBeTruthy();

      const waited = await client.callTool({
        name: 'mma_execution_wait',
        arguments: { executionId: handle.executionId, timeoutMs: 300_000 },
      });
      expect(waited.isError, 'an over-large wait must not be an error').toBeFalsy();
      const payload = JSON.parse(((waited.content as Array<{ text: string }>)[0]!).text) as
        Record<string, unknown>;
      expect(payload.executionId ?? (payload.execution as { executionId?: string })?.executionId).toBe(handle.executionId);
    } finally {
      await client.close();
      await h.close();
    }
  });
});
