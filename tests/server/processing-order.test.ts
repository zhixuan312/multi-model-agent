import { describe, it, expect } from 'vitest';
import { startTestServer } from '../helpers/test-server.js';

describe('request processing order', () => {
  it('413 payload_too_large precedes auth when body exceeds cap', async () => {
    const s = await startTestServer({ server: { limits: { maxBodyBytes: 100 } } });
    try {
      const big = 'x'.repeat(200);
      const res = await fetch(`${s.url}/delegate?cwd=/tmp`, { method: 'POST', body: big });
      expect(res.status).toBe(413);
      const body = await res.json();
      expect(body.error.code).toBe('payload_too_large');
    } finally {
      await s.stop();
    }
  });

  it('404 not_found precedes auth on unknown path', async () => {
    const s = await startTestServer();
    try {
      const res = await fetch(`${s.url}/bogus`);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error.code).toBe('not_found');
    } finally {
      await s.stop();
    }
  });

  it('405 method_not_allowed with allowed methods in details', async () => {
    const s = await startTestServer();
    try {
      // /delegate is registered for POST only; DELETE should get 405
      const res = await fetch(`${s.url}/delegate`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${s.token}` },
      });
      expect(res.status).toBe(405);
      const body = await res.json();
      expect(body.error.code).toBe('method_not_allowed');
      expect(body.error.details.allowed).toContain('POST');
    } finally {
      await s.stop();
    }
  });

  it('401 unauthorized when bearer missing (after route match)', async () => {
    const s = await startTestServer();
    try {
      // Small body (< limit); route exists (POST /delegate); no auth
      const res = await fetch(`${s.url}/delegate`, {
        method: 'POST',
        body: '{}',
        headers: { 'content-type': 'application/json' },
      });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.code).toBe('unauthorized');
    } finally {
      await s.stop();
    }
  });

  it('400 invalid_json after auth succeeds', async () => {
    const s = await startTestServer();
    try {
      const res = await fetch(`${s.url}/delegate?cwd=/tmp`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${s.token}`,
          'content-type': 'application/json',
        },
        body: '{not json',
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('invalid_json');
    } finally {
      await s.stop();
    }
  });
});
