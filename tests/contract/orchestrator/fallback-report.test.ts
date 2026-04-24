// Pins fallback structured-report behavior: when the implementer does not
// emit a structured report of its own, the envelope still carries a
// `structuredReport` + `implementationReport` with the documented
// fallback fields (summary, filesChanged, validationsRun,
// deviationsFromBrief, unresolved). Ch 6 will move
// `buildFallbackImplReport` into its own file; this test ensures the
// fallback shape survives.
import { describe, it, expect } from 'vitest';
import { boot } from '../fixtures/harness.js';
import { mockProvider } from '../fixtures/mock-providers.js';

const FALLBACK_KEYS = ['summary', 'filesChanged', 'validationsRun', 'deviationsFromBrief', 'unresolved'] as const;

describe('contract: orchestrator fallback report', () => {
  it('terminal envelope always carries structuredReport + implementationReport with fallback keys', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const d = await fetch(`${h.baseUrl}/delegate?cwd=${encodeURIComponent(process.cwd())}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${h.token}` },
        body: JSON.stringify({ tasks: [{ prompt: 'fallback-report test' }] }),
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
      expect(Array.isArray(results) && results.length > 0).toBe(true);
      for (const r of results) {
        const sr = r.structuredReport as Record<string, unknown>;
        const ir = r.implementationReport as Record<string, unknown>;
        expect(sr).toBeDefined();
        expect(ir).toBeDefined();
        for (const key of FALLBACK_KEYS) {
          expect(sr, `structuredReport missing ${key}`).toHaveProperty(key);
          expect(ir, `implementationReport missing ${key}`).toHaveProperty(key);
        }
        expect(Array.isArray(sr.filesChanged)).toBe(true);
        expect(Array.isArray(sr.validationsRun)).toBe(true);
        expect(Array.isArray(sr.deviationsFromBrief)).toBe(true);
        expect(Array.isArray(sr.unresolved)).toBe(true);
      }
    } finally {
      await h.close();
    }
  }, 60_000);
});
