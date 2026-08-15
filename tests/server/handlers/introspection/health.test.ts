// tests/server/handlers/introspection/health.test.ts
import { describe, it, expect } from 'vitest';
import { startTestServer } from '../../../helpers/test-server.js';
import { shouldRejectNonLoopback } from '../../../../packages/core/src/transport/loopback-enforcer.js';

/**
 * `GET /health` answers two questions, and only one of them was ever asked here.
 *
 * The healthy shape had three cases, each booting its own server: one asserting
 * `toEqual({ status: 'ok' })` followed by six `not.toHaveProperty` calls that `toEqual` already
 * implies, one asserting the key set is exactly `['status']` — implied by the same `toEqual` —
 * and one asserting `status === 200` from loopback, which every other case also asserts and which
 * cannot fail for a loopback-specific reason, since the test server only ever binds loopback (the
 * file's own comment says so, further down).
 *
 * Meanwhile the DRIFT branch — missing, outdated, orphaned or failed provisioning, the entire
 * reason this endpoint does more than answer "alive" — had no coverage at all, because
 * `startTestServer` hardcoded an empty drift report and gave no way to pin a different one.
 */
describe('GET /health', () => {
  it('returns exactly { status: "ok" } when nothing has drifted', async () => {
    const s = await startTestServer();
    try {
      const res = await fetch(`${s.url}/health`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');
      // Exact: no version, pid, uptimeMs, counters or project data. `toEqual` is strict in both
      // directions, so an added field fails here without a list of names to keep in step.
      expect(await res.json()).toEqual({ status: 'ok' });
    } finally {
      await s.stop();
    }
  });

  it('reports every drift entry, unauthenticated, with status drift', async () => {
    const drift = [
      { skill: 'mma-audit', client: 'claude-code', issue: 'outdated' as const },
      { skill: 'mma-plan', client: 'codex', issue: 'missing' as const },
      { skill: 'mma-gone', client: 'cursor', issue: 'orphan' as const },
      { skill: 'mma-review', client: 'windsurf', issue: 'failed' as const },
    ];
    const s = await startTestServer(undefined, { manifestSync: { driftReport: () => drift } });
    try {
      // No Authorization header: /health is the unauthenticated liveness probe, and a drift
      // response must not quietly become authenticated.
      const res = await fetch(`${s.url}/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'drift', drift });
    } finally {
      await s.stop();
    }
  });

  it('reports drift from an async report too — the seam allows a promise', async () => {
    const drift = [{ skill: 'mma-spec', client: 'claude-code', issue: 'outdated' as const }];
    const s = await startTestServer(undefined, {
      manifestSync: { driftReport: () => Promise.resolve(drift) },
    });
    try {
      expect(await (await fetch(`${s.url}/health`)).json()).toEqual({ status: 'drift', drift });
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
