// Pins the v4.4.x unified StructuredReport shape carried on every terminal
// envelope. The Annotating handler is a pure transform that always runs,
// so structuredReport is never missing — and it always carries the
// canonical fields regardless of whether the worker emitted any of them.
import { describe, it, expect } from 'vitest';
import { boot } from '../fixtures/harness.js';
import { mockProvider } from '../fixtures/mock-providers.js';

const REPORT_KEYS = [
  'summary',
  'workerStatus',
  'unresolved',
  'filesChanged',
  'reviewVerdict',
  'reviewConcerns',
  'reworkApplied',
  'validationsRun',
  'commitSha',
  'commitMessage',
  'commitSkipReason',
  'findings',
  'criteriaErrors',
] as const;

describe('contract: orchestrator unified report', () => {
  it('terminal envelope always carries the unified StructuredReport with v4.4.x fields', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const d = await fetch(`${h.baseUrl}/delegate?cwd=${encodeURIComponent(process.cwd())}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', "X-MMA-Main-Model": "claude-opus-4-7", "X-MMA-Client": "claude-code", Authorization: `Bearer ${h.token}` },
        body: JSON.stringify({ tasks: [{ prompt: 'fallback-report test', reviewPolicy: 'none' }] }),
      });
      const { batchId } = (await d.json()) as { batchId: string };
      let envelope: Record<string, unknown> | null = null;
      for (let i = 0; i < 180; i++) {
        const p = await fetch(`${h.baseUrl}/batch/${batchId}`, { headers: { "X-MMA-Main-Model": "claude-opus-4-7", "X-MMA-Client": "claude-code", Authorization: `Bearer ${h.token}` } });
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
        expect(sr).toBeDefined();
        for (const key of REPORT_KEYS) {
          expect(sr, `structuredReport missing ${key}`).toHaveProperty(key);
        }
        expect(Array.isArray(sr.filesChanged)).toBe(true);
        expect(Array.isArray(sr.validationsRun)).toBe(true);
        expect(Array.isArray(sr.unresolved)).toBe(true);
        expect(Array.isArray(sr.findings)).toBe(true);
        expect(Array.isArray(sr.criteriaErrors)).toBe(true);
      }
    } finally {
      await h.close();
    }
  }, 60_000);
});
