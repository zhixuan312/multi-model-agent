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
    const response = await fetch(`${handle.url}/delegate?cwd=${encodeURIComponent(logDir)}`, {
      method: 'POST',
      headers: {
        'X-MMA-Client': 'claude-code',
        'X-MMA-Main-Model': 'claude-opus-4-7',
        'Authorization': `Bearer ${handle.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ tasks: [{ prompt: 'noop' }] }),
    });
    expect(response.ok).toBe(true);

    // Poll until directory state stabilizes (no new files for 200ms or max timeout).
    const maxWaitTime = 5000;
    const pollInterval = 50;
    const stabilizationMs = 200;
    let lastCheckTime = Date.now();
    let lastFileCount = 0;

    const startTime = Date.now();
    while (Date.now() - startTime < maxWaitTime) {
      await new Promise((r) => setTimeout(r, pollInterval));

      const currentEntries = readdirSync(logDir).filter(
        (n) => n.startsWith('mmagent-') && n.endsWith('.jsonl'),
      );

      if (currentEntries.length === lastFileCount) {
        // No new files since last check
        if (Date.now() - lastCheckTime >= stabilizationMs) {
          // Stable for long enough, async work is complete
          break;
        }
      } else {
        // File count changed, reset stabilization timer
        lastFileCount = currentEntries.length;
        lastCheckTime = Date.now();
      }
    }

    const entries = readdirSync(logDir).filter(
      (n) => n.startsWith('mmagent-') && n.endsWith('.jsonl'),
    );
    expect(entries).toEqual([]);
  });
});
