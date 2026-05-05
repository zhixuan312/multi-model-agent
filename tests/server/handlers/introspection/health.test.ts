// tests/server/handlers/introspection/health.test.ts
import { describe, it, expect } from 'vitest';
import { startTestServer } from '../../../helpers/test-server.js';
import { shouldRejectNonLoopback } from '../../../../packages/server/src/http/loopback.js';

describe('GET /health', () => {
  it('returns 200 with { status: "ok" } when no drift — no other fields', async () => {
    const s = await startTestServer();
    try {
      const res = await fetch(`${s.url}/health`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');
      const body = await res.json();
      expect(body).toEqual({ status: 'ok' });
      expect(body).not.toHaveProperty('drift');
      expect(body).not.toHaveProperty('version');
      expect(body).not.toHaveProperty('ok');
      expect(body).not.toHaveProperty('pid');
      expect(body).not.toHaveProperty('startedAt');
      expect(body).not.toHaveProperty('uptimeMs');
    } finally {
      await s.stop();
    }
  });

  it('returns 200 from loopback (127.0.0.1) — the test server always binds loopback', async () => {
    const s = await startTestServer();
    try {
      const res = await fetch(`${s.url}/health`);
      expect(res.status).toBe(200);
    } finally {
      await s.stop();
    }
  });

  it('body keys are exactly status when no drift — no counters, no project data', async () => {
    const s = await startTestServer();
    try {
      const res = await fetch(`${s.url}/health`);
      const body = await res.json() as Record<string, unknown>;
      expect(new Set(Object.keys(body))).toEqual(new Set(['status']));
      expect(body['status']).toBe('ok');
    } finally {
      await s.stop();
    }
  });

  // Isolation test: shouldRejectNonLoopback logic covers the 403 case.
  // fetch() from localhost always connects via loopback so we can't trigger
  // the 403 via the network — test the guard function directly instead.
  describe('shouldRejectNonLoopback (unit)', () => {
    it('returns false for loopback addresses', () => {
      expect(shouldRejectNonLoopback('127.0.0.1')).toBe(false);
      expect(shouldRejectNonLoopback('::1')).toBe(false);
      expect(shouldRejectNonLoopback('localhost')).toBe(false);
      expect(shouldRejectNonLoopback('::ffff:127.0.0.1')).toBe(false);
    });

    it('returns true for non-loopback addresses (should be rejected)', () => {
      expect(shouldRejectNonLoopback('192.168.1.1')).toBe(true);
      expect(shouldRejectNonLoopback('10.0.0.1')).toBe(true);
      expect(shouldRejectNonLoopback('2001:db8::1')).toBe(true);
      expect(shouldRejectNonLoopback(undefined)).toBe(true);
    });
  });
});
