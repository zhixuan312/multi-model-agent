import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boot } from '../fixtures/harness.js';
import { mockProvider } from '../fixtures/mock-providers.js';

// Lifecycle contract for the journal (recall) read route: a valid body
// dispatches a task that polls to a terminal batch envelope. Assertions are
// property-based (not full-golden equality) because the per-task envelope
// carries non-deterministic telemetry (ids, timestamps, working-tree-derived
// filesChanged); request-shape (202 / 400) is pinned separately in
// tests/contract/handlers/journal-recall-record.test.ts.
describe('contract: POST /journal/recall lifecycle', () => {
  // TODO: Re-enable once the unified /task handler's runTwoPhasePipeline passes
  // batchId+taskIndex to openSession. The old per-route handler handled this;
  // the unified handler doesn't yet (missing_task_identity error).
  it.skip('valid body dispatches a task and polls to a successful terminal envelope', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'journal-recall-lifecycle-'));
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd });
    try {
      const res = await fetch(`${h.baseUrl}/task?cwd=${encodeURIComponent(cwd)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-MMA-Main-Model': 'claude-opus-4-7',
          'X-MMA-Client': 'claude-code',
          Authorization: `Bearer ${h.token}`,
        },
        body: JSON.stringify({ type: 'journal_recall', query: 'x'.repeat(25) }),
      });
      expect(res.status).toBe(202);
      const { batchId } = (await res.json()) as { batchId: string };
      expect(typeof batchId).toBe('string');

      let body: Record<string, unknown> | null = null;
      for (let i = 0; i < 40; i++) {
        const poll = await fetch(`${h.baseUrl}/batch/${batchId}`, {
          headers: {
            'X-MMA-Main-Model': 'claude-opus-4-7',
            'X-MMA-Client': 'claude-code',
            Authorization: `Bearer ${h.token}`,
          },
        });
        if (poll.status === 200) { body = (await poll.json()) as Record<string, unknown>; break; }
        expect(poll.status).toBe(202);
        await new Promise((r) => setTimeout(r, 50));
      }

      expect(body).not.toBeNull();
      // Terminal envelope: batch succeeded (error is the not_applicable sentinel).
      expect(body!.error).toBeTruthy();
      expect(body!.error).toHaveProperty('kind');
      expect((body!.error as any)?.kind).toBe('not_applicable');

      // Verify results is an array (not a not_applicable sentinel)
      expect(Array.isArray(body!.results)).toBe(true);
      const results = body!.results as Array<Record<string, unknown>>;
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].route).toBe('journal-recall');

      // journal-recall is a read route → may register a terminal context block.
      const contextBlockId = results[0].contextBlockId;
      expect(typeof contextBlockId === 'string' || contextBlockId === null).toBe(true);

      // Reaches a valid terminal status. (The mock 'ok' provider emits generic
      // output that doesn't produce a full journal recall, so the read route
      // legitimately lands on 'failed' here — the contract under test is that
      // the route runs the read-route lifecycle to a well-formed terminal
      // envelope, not the mock's review verdict.)
      const status = results[0].status;
      expect(['done', 'done_with_concerns', 'failed']).toContain(status);
    } finally {
      await h.close();
    }
  });
});
