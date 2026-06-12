import { describe, it, expect } from 'vitest';
import { boot } from '../fixtures/harness.js';
import { mockProvider } from '../fixtures/mock-providers.js';

describe('contract: tool routes require X-MMA-Main-Model header', () => {
  it('returns 400 main_model_required when header is missing', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await fetch(`${h.baseUrl}/task?cwd=${encodeURIComponent(process.cwd())}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-MMA-Client': 'claude-code',
          Authorization: `Bearer ${h.token}`,
        },
        body: JSON.stringify({ type: 'review', filePaths: ['/tmp/noop.ts'] }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: { code?: string } | string };
      const code = typeof body.error === 'string' ? body.error : body.error?.code;
      expect(code).toBe('main_model_required');
    } finally {
      await h.close();
    }
  });

  it('accepts the same request when X-MMA-Main-Model is set', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await fetch(`${h.baseUrl}/task?cwd=${encodeURIComponent(process.cwd())}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-MMA-Client': 'claude-code',
          'X-MMA-Main-Model': 'claude-opus-4-7',
          Authorization: `Bearer ${h.token}`,
        },
        body: JSON.stringify({ type: 'review', filePaths: ['/tmp/noop.ts'] }),
      });
      expect(res.status).toBe(202);
    } finally {
      await h.close();
    }
  });
});
