import { describe, it, expect } from 'vitest';
import { boot } from '../fixtures/harness.js';
import { mockProvider } from '../fixtures/mock-providers.js';

// This file used to assert an X-MMA-Main-Model requirement. That header is gone:
// the cost baseline is now the daemon's configured `agents.main` tier, so there is
// nothing per-call to enforce for it. X-MMA-Client is the one attribution header
// that survives at this boundary, and it was untested.
describe('contract: tool routes require the X-MMA-Client header', () => {
  it('returns 400 client_required when the header is missing', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await fetch(`${h.baseUrl}/task?cwd=${encodeURIComponent(process.cwd())}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${h.token}`,
        },
        body: JSON.stringify({ type: 'review', target: { paths: ['/tmp/noop.ts'] } }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: { code?: string } | string };
      const code = typeof body.error === 'string' ? body.error : body.error?.code;
      expect(code).toBe('client_required');
    } finally {
      await h.close();
    }
  });

  it('returns 400 client_required for a value outside the canonical roster', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await fetch(`${h.baseUrl}/task?cwd=${encodeURIComponent(process.cwd())}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-MMA-Client': 'not-a-real-client',
          Authorization: `Bearer ${h.token}`,
        },
        body: JSON.stringify({ type: 'review', target: { paths: ['/tmp/noop.ts'] } }),
      });
      expect(res.status).toBe(400);
    } finally {
      await h.close();
    }
  });

  it('accepts the same request with only X-MMA-Client set — no model header needed', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await fetch(`${h.baseUrl}/task?cwd=${encodeURIComponent(process.cwd())}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-MMA-Client': 'claude-code',
          Authorization: `Bearer ${h.token}`,
        },
        body: JSON.stringify({ type: 'review', target: { paths: ['/tmp/noop.ts'] } }),
      });
      expect(res.status).toBe(202);
    } finally {
      await h.close();
    }
  });
});
