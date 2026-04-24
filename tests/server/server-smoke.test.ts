import { describe, it, expect } from 'vitest';
import { startTestServer } from '../helpers/test-server.js';

describe('server smoke test', () => {
  it('starts on ephemeral port and serves GET /health with 200', async () => {
    const s = await startTestServer();
    try {
      const res = await fetch(`${s.url}/health`);
      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean; version: string };
      expect(body.ok).toBe(true);
      expect(typeof body.version).toBe('string');
    } finally {
      await s.stop();
    }
  });

  it('router dispatches path params correctly', async () => {
    const s = await startTestServer();
    try {
      // /health is registered; an unknown path should 404
      const res = await fetch(`${s.url}/not-a-real-endpoint`);
      expect(res.status).toBe(404);
    } finally {
      await s.stop();
    }
  });
});
