import { describe, it, expect, vi } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { startTestServer } from '../fixtures/start-test-server.js';
import { mockProvider } from '../fixtures/mock-providers.js';

// Verifies the v0.5 invariant: a single task opens at most ONE session per
// tier, and each opened session is closed exactly once when the task ends.
// The old delegateWithEscalation wrapper used to open a fresh session per
// retry attempt; this test would have caught that leak.

function makeGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email test@example.com', { cwd: dir });
  execSync('git config user.name test', { cwd: dir });
  writeFileSync(join(dir, 'README.md'), 'init\n');
  execSync('git add . && git commit -q -m init', { cwd: dir });
}

describe('session cache invariant — one open per (task, tier)', () => {
  it('write-route task opens at most 1 session per tier and closes each exactly once', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'sess-cache-'));
    makeGitRepo(cwd);
    const openSpy = vi.fn();
    const closeSpy = vi.fn();
    const provider = mockProvider({ stage: 'ok', onOpen: openSpy, onClose: closeSpy });
    const server = await startTestServer({ cwd, provider });
    const headers = {
      Authorization: `Bearer ${server.token}`,
      'X-MMA-Client': 'claude-code',
      'X-MMA-Main-Model': 'claude-opus-4-7',
      'Content-Type': 'application/json',
    };
    try {
      const dispatch = await fetch(`${server.baseUrl}/delegate?cwd=${encodeURIComponent(cwd)}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ tasks: [{ prompt: 'noop' }] }),
      });
      expect(dispatch.status).toBe(202);
      const { batchId } = (await dispatch.json()) as { batchId: string };
      // Poll to terminal.
      for (let i = 0; i < 200; i++) {
        const r = await fetch(`${server.baseUrl}/batch/${batchId}`, { headers });
        if (r.status === 200) break;
        await new Promise((res) => setTimeout(res, 50));
      }
      // Invariant: open ≤ 2 (one per tier max), close === open count, no leak.
      expect(openSpy.mock.calls.length).toBeLessThanOrEqual(2);
      expect(closeSpy.mock.calls.length).toBe(openSpy.mock.calls.length);
    } finally {
      await server.close();
    }
  });
});
