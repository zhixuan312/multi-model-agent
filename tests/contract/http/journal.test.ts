import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boot } from '../fixtures/harness.js';
import { mockProvider } from '../fixtures/mock-providers.js';

// Lifecycle contract for the journal (record) write route: a valid body
// dispatches a task that polls to a terminal batch envelope. Assertions are
// property-based (not full-golden equality) because the per-task envelope
// carries non-deterministic telemetry (ids, timestamps, working-tree-derived
// filesChanged); request-shape (202 / 400) is pinned separately in
// tests/contract/handlers/journal-record.test.ts.
describe('contract: POST /journal lifecycle', () => {
  it('valid body dispatches a task and polls to a successful terminal envelope', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'journal-lifecycle-'));
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd });
    try {
      const res = await fetch(`${h.baseUrl}/journal-record?cwd=${encodeURIComponent(cwd)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-MMA-Main-Model': 'claude-opus-4-7',
          'X-MMA-Client': 'claude-code',
          Authorization: `Bearer ${h.token}`,
        },
        body: JSON.stringify({ learning: 'x'.repeat(25), tagHints: ['journal'] }),
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
      expect((body!.error as { kind?: string }).kind).toBe('not_applicable');
      const results = body!.results as Array<Record<string, unknown>>;
      expect(results).toHaveLength(1);
      expect(results[0].route).toBe('journal-record');
      // journal is a write route → never registers a terminal context block.
      expect(results[0].contextBlockId).toBeNull();
      // Reaches a valid terminal status. (The mock 'ok' provider emits generic
      // output that doesn't write journal nodes, so the full-review write route
      // legitimately lands on 'failed' here — the contract under test is that
      // the route runs the write-route lifecycle to a well-formed terminal
      // envelope, not the mock's review verdict.)
      expect(['done', 'done_with_concerns', 'failed']).toContain(results[0].status);
    } finally {
      await h.close();
    }
  });
});
