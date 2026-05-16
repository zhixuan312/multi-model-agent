import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServerWithAgents } from '../helpers/test-server-with-agents.js';

describe('No JSONL on disk when diagnostics.log is false (A3)', () => {
  const cleanup: Array<() => void> = [];
  afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });

  it('writes no mmagent-*.jsonl when diagnostics.log is false', async () => {
    const logDir = mkdtempSync(join(tmpdir(), 'mma-no-jsonl-'));
    cleanup.push(() => rmSync(logDir, { recursive: true, force: true }));

    const handle = await startTestServerWithAgents({
      diagnostics: { log: false, logDir },
    });
    cleanup.push(() => { void handle.stop(); });

    // Send a request (any tool route; will not actually invoke a provider but
    // exercises the request handler enough to fire bus events).
    await fetch(`${handle.url}/delegate?cwd=${encodeURIComponent(logDir)}`, {
      method: 'POST',
      headers: {
        'X-MMA-Client': 'claude-code',
        'X-MMA-Main-Model': 'claude-opus-4-7',
        'Authorization': `Bearer ${handle.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ tasks: [{ prompt: 'noop' }] }),
    });

    // Give the async-dispatch path a moment to fire bus events.
    await new Promise((r) => setTimeout(r, 200));

    const entries = readdirSync(logDir).filter(
      (n) => n.startsWith('mmagent-') && n.endsWith('.jsonl'),
    );
    expect(entries).toEqual([]);
  });
});
