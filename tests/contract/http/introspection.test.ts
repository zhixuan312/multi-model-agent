import { describe, it, expect } from 'vitest';
import { boot } from '../fixtures/harness.js';
import { mockProvider } from '../fixtures/mock-providers.js';
import { normalize } from '../serializer/index.js';
import statusGolden from '../goldens/introspection/status.json' with { type: 'json' };
import healthGolden from '../goldens/introspection/health.json' with { type: 'json' };
import unauthGolden from '../goldens/errors/unauthorized.json' with { type: 'json' };
import invalidRequestGolden from '../goldens/errors/invalid-request.json' with { type: 'json' };
import notFoundGolden from '../goldens/errors/not-found.json' with { type: 'json' };

async function authedFetch(url: string, token: string, init?: RequestInit): Promise<Response> {
  return await fetch(url, {
    ...init,
    headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}` },
  });
}

describe('contract: introspection + errors', () => {
  it('GET /health returns the golden shape', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await fetch(`${h.baseUrl}/health`);
      expect(res.status).toBe(200);
      expect(normalize(await res.json())).toEqual(healthGolden);
    } finally {
      await h.close();
    }
  });

  it('GET /status returns the golden shape', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await authedFetch(`${h.baseUrl}/status`, h.token);
      expect(res.status).toBe(200);
      expect(normalize(await res.json())).toEqual(statusGolden);
    } finally {
      await h.close();
    }
  });

  it('missing token returns unauthorized error envelope', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await fetch(`${h.baseUrl}/delegate?cwd=${encodeURIComponent(process.cwd())}`, {
        method: 'POST',
      });
      expect(res.status).toBe(401);
      expect(normalize(await res.json())).toEqual(unauthGolden);
    } finally {
      await h.close();
    }
  });

  it('invalid request returns the golden error envelope', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await authedFetch(`${h.baseUrl}/context-blocks?cwd=${encodeURIComponent(process.cwd())}`, h.token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      expect(normalize(await res.json())).toEqual(invalidRequestGolden);
    } finally {
      await h.close();
    }
  });

  it('unknown path returns not-found error envelope', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await authedFetch(`${h.baseUrl}/definitely-not-a-route`, h.token);
      expect(res.status).toBe(404);
      expect(normalize(await res.json())).toEqual(notFoundGolden);
    } finally {
      await h.close();
    }
  });
});
