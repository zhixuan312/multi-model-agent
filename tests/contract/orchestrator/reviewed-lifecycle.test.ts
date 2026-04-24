// Pins the reviewed-lifecycle envelope surface: specReviewStatus,
// qualityReviewStatus, specReviewReason, qualityReviewReason must all be
// present alongside the reviewed artifacts (implementer output +
// structuredReport). Ch 6 moves the reviewed lifecycle into
// run-tasks/reviewed-lifecycle.ts; this test is the envelope-visible
// guardrail.
import { describe, it, expect } from 'vitest';
import { boot } from '../fixtures/harness.js';
import { mockProvider } from '../fixtures/mock-providers.js';

describe('contract: reviewed lifecycle', () => {
  it('review-rework stage envelope carries spec + quality review fields and reasons', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'review-rework' }), cwd: process.cwd() });
    try {
      const d = await fetch(`${h.baseUrl}/delegate?cwd=${encodeURIComponent(process.cwd())}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${h.token}` },
        body: JSON.stringify({ tasks: [{ prompt: 'reviewed-lifecycle test' }] }),
      });
      const { batchId } = (await d.json()) as { batchId: string };
      let envelope: Record<string, unknown> | null = null;
      for (let i = 0; i < 180; i++) {
        const p = await fetch(`${h.baseUrl}/batch/${batchId}`, { headers: { Authorization: `Bearer ${h.token}` } });
        if (p.status === 200) {
          envelope = (await p.json()) as Record<string, unknown>;
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(envelope).not.toBeNull();
      const results = envelope!.results as Array<Record<string, unknown>>;
      for (const r of results) {
        expect(r).toHaveProperty('specReviewStatus');
        expect(r).toHaveProperty('qualityReviewStatus');
        expect(r).toHaveProperty('specReviewReason');
        expect(r).toHaveProperty('qualityReviewReason');
        expect(r).toHaveProperty('agents');
        expect(r).toHaveProperty('models');
        const agents = r.agents as Record<string, unknown>;
        expect(agents).toHaveProperty('implementer');
        expect(agents).toHaveProperty('specReviewer');
        expect(agents).toHaveProperty('qualityReviewer');
      }
      expect(envelope!.batchTimings).toBeDefined();
      expect(envelope!.costSummary).toBeDefined();
    } finally {
      await h.close();
    }
  }, 60_000);
});
