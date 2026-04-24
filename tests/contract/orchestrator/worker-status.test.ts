// Orchestrator-visible invariants for worker status + top-level status.
// Pins shape and coupling between envelope fields: every terminal result must
// have status, workerStatus, specReviewStatus, qualityReviewStatus (even when
// the reviews are not applicable). These fields survive Chapter 6's
// run-tasks decomposition or the refactor broke the envelope contract.
import { describe, it, expect } from 'vitest';
import { boot } from '../fixtures/harness.js';
import { mockProvider, type Stage } from '../fixtures/mock-providers.js';

const STAGES: Stage[] = ['ok', 'incomplete', 'force-salvage', 'max-turns', 'clarification', 'review-rework'];
const VALID_WORKER_STATUS = new Set(['done', 'partial', 'blocked', 'needs_input', 'reviewing']);
const VALID_REVIEW_STATUS = new Set(['approved', 'changes_required', 'not_applicable']);

async function dispatchAndWait(stage: Stage): Promise<Record<string, unknown>> {
  const h = await boot({ provider: mockProvider({ stage }), cwd: process.cwd() });
  try {
    const d = await fetch(`${h.baseUrl}/delegate?cwd=${encodeURIComponent(process.cwd())}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${h.token}` },
      body: JSON.stringify({ tasks: [{ prompt: `orchestrator worker-status ${stage}` }] }),
    });
    const { batchId } = (await d.json()) as { batchId: string };
    for (let i = 0; i < 180; i++) {
      const p = await fetch(`${h.baseUrl}/batch/${batchId}`, { headers: { Authorization: `Bearer ${h.token}` } });
      if (p.status === 200) return (await p.json()) as Record<string, unknown>;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('poll timeout');
  } finally {
    await h.close();
  }
}

describe('contract: orchestrator worker-status derivation', () => {
  for (const stage of STAGES) {
    it(`${stage}: terminal envelope pins workerStatus + review-status fields`, async () => {
      const envelope = await dispatchAndWait(stage);
      const results = envelope.results as Array<Record<string, unknown>>;
      expect(Array.isArray(results) && results.length > 0).toBe(true);
      for (const r of results) {
        expect(typeof r.status).toBe('string');
        expect(VALID_WORKER_STATUS.has(r.workerStatus as string), `workerStatus=${String(r.workerStatus)}`).toBe(true);
        expect(VALID_REVIEW_STATUS.has(r.specReviewStatus as string), `specReviewStatus=${String(r.specReviewStatus)}`).toBe(true);
        expect(VALID_REVIEW_STATUS.has(r.qualityReviewStatus as string), `qualityReviewStatus=${String(r.qualityReviewStatus)}`).toBe(true);
      }
    }, 60_000);
  }
});
