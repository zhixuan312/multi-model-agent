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
 * `mma_task_wait` advertised `capped at 240000` while typical MCP hosts abort a tool call
 * after ~60s. On Claude Desktop the model read that ceiling, asked for it, and got
 * `-32001 Request timed out` — no snapshot, no taskId context, no sign the task was still
 * running perfectly well. The schema was inviting a request the transport could never
 * deliver.
 *
 * `INLINE_WAIT_CAP_MS` already encoded the correct bound with the correct reasoning ("below
 * typical MCP client tool timeouts"); the wait ceiling simply disagreed with it. These tests
 * bind the two together so they cannot drift apart again.
 */
describe('contract: mma_task_wait timeout bounds fit inside client request deadlines', () => {
  it('caps the advertised wait at the same bound as the inline wait', () => {
    expect(WAIT_CAP_MS).toBe(INLINE_WAIT_CAP_MS);
  });

  it('stays under 60s, the deadline typical MCP hosts enforce on a single tool call', () => {
    expect(WAIT_CAP_MS).toBeLessThan(60_000);
    expect(WAIT_DEFAULT_MS).toBeLessThanOrEqual(WAIT_CAP_MS);
  });

  it('publishes that same ceiling in the tool schema the model actually reads', () => {
    const wait = MCP_TOOLS.find((t) => t.name === 'mma_task_wait');
    expect(wait).toBeDefined();
    const timeout = (wait!.inputSchema as {
      properties: { timeoutMs: { maximum: number; description: string } };
    }).properties.timeoutMs;
    expect(timeout.maximum).toBe(WAIT_CAP_MS);
    expect(timeout.description).toContain(String(WAIT_CAP_MS));
    expect(timeout.description).not.toContain('240000');
  });

  it('tells the model a timeout is not a failure, so it re-waits instead of giving up', () => {
    const wait = MCP_TOOLS.find((t) => t.name === 'mma_task_wait')!;
    expect(wait.description).toMatch(/not an error|NOT an error/i);
    expect(wait.description).toMatch(/call again/i);
  });
});
