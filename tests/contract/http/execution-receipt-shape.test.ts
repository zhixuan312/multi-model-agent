/**
 * `POST /execution`'s 202 receipt has ONE shape, whichever branch builds it.
 *
 * The handler prefers the admitted registry entry (`executionIdentity`) and falls back to a
 * literal when the entry is missing. That fallback used to be `{ executionId, type }` — two of the
 * five fields — silently dropping `method` and `cwd`.
 *
 * It is reached only if the entry is evicted between `submit()` returning and the lookup one line
 * later, which against an hour-long TTL is close to impossible. That is precisely what made the
 * divergence dangerous: no test exercised it, no reviewer met it, and a caller reading `cwd` off
 * the receipt would have got `undefined` in the one case nobody could reproduce.
 *
 * Both branches are asserted here against the same expectation, with the fallback reached by
 * emptying the registry — the only way to make that path run deterministically.
 */
import { describe, expect, it } from 'vitest';
import { boot } from '../fixtures/harness.js';
import { mockProvider } from '../fixtures/mock-providers.js';

const RECEIPT_KEYS = ['executionId', 'type', 'method', 'cwd', 'statusUrl'] as const;

async function submit(baseUrl: string, token: string, cwd: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl}/execution?cwd=${encodeURIComponent(cwd)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-MMA-Client': 'claude-code' },
    body: JSON.stringify({ type: 'investigate', prompt: 'receipt shape' }),
  });
  expect(res.status).toBe(202);
  return await res.json() as Record<string, unknown>;
}

describe('POST /execution receipt shape', () => {
  it('carries identity and cwd on the normal path', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const receipt = await submit(h.baseUrl, h.token, process.cwd());
      expect(Object.keys(receipt).sort()).toEqual([...RECEIPT_KEYS].sort());
      expect(receipt.type).toBe('investigate');
      expect(receipt.cwd).toBe(process.cwd());
      expect(receipt.method).toBeNull();
      expect(receipt.statusUrl).toBe(`/execution/${receipt.executionId as string}`);
    } finally { await h.close(); }
  });

  it('carries the SAME keys when the registry entry is already gone', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      // Evict everything the instant it is admitted, so the handler's lookup misses and the
      // fallback branch is the one that builds the receipt.
      const registry = h.executionRegistry as unknown as { get: (id: string) => unknown };
      const realGet = registry.get.bind(registry);
      registry.get = () => undefined;
      try {
        const receipt = await submit(h.baseUrl, h.token, process.cwd());
        expect(Object.keys(receipt).sort(), 'the fallback receipt dropped fields').toEqual([...RECEIPT_KEYS].sort());
        expect(receipt.type).toBe('investigate');
        expect(receipt.cwd).toBe(process.cwd());
        expect(receipt.method).toBeNull();
      } finally {
        registry.get = realGet;
      }
    } finally { await h.close(); }
  });
});
