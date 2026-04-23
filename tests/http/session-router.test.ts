import { describe, it, expect, beforeEach } from 'vitest';
import { SessionRouter } from '../../packages/mcp/src/http/session-router.js';

const fakeEntry = (_id: string) => ({
  transport: { close: async () => {}, handleRequest: async () => {} } as any,
  server: { close: async () => {} } as any,
  projectContext: { cwd: '/tmp', activeSessions: new Set(), activeRequests: 0, pendingReservations: 0 } as any,
  openedAt: Date.now(),
  lastRequestAt: Date.now(),
});

describe('SessionRouter', () => {
  let router: SessionRouter;
  beforeEach(() => { router = new SessionRouter(); });

  it('set() and get() round-trip', () => {
    router.set('s1', fakeEntry('s1'));
    expect(router.get('s1')).toBeDefined();
  });

  it('get() on unknown sessionId returns undefined', () => {
    expect(router.get('nope')).toBeUndefined();
  });

  it('remove() disposes and drops the entry', async () => {
    const entry = fakeEntry('s1');
    let closed = false;
    entry.transport.close = async () => { closed = true; };
    router.set('s1', entry);
    await router.remove('s1');
    expect(router.get('s1')).toBeUndefined();
    expect(closed).toBe(true);
  });

  it('delete() drops the entry WITHOUT calling transport.close() (for use from onclose)', () => {
    const entry = fakeEntry('s1');
    let closed = false;
    entry.transport.close = async () => { closed = true; };
    router.set('s1', entry);
    router.delete('s1');
    expect(router.get('s1')).toBeUndefined();
    expect(closed).toBe(false);
  });

  it('closeAll disposes every session', async () => {
    let n = 0;
    const mk = (id: string) => {
      const e = fakeEntry(id);
      e.transport.close = async () => { n += 1; };
      return e;
    };
    router.set('s1', mk('s1'));
    router.set('s2', mk('s2'));
    await router.closeAll();
    expect(n).toBe(2);
    expect(router.size).toBe(0);
  });

  it('size reflects current entries', () => {
    expect(router.size).toBe(0);
    router.set('s1', fakeEntry('s1'));
    router.set('s2', fakeEntry('s2'));
    expect(router.size).toBe(2);
  });

  it('touchSession updates lastRequestAt', () => {
    const entry = fakeEntry('s1');
    entry.lastRequestAt = 0;
    router.set('s1', entry);
    router.touchSession('s1');
    expect(entry.lastRequestAt).toBeGreaterThan(0);
  });

  it('evictIdleSessions removes stale sessions and skips fresh ones', async () => {
    const fresh = fakeEntry('fresh');
    fresh.lastRequestAt = Date.now();
    const stale = fakeEntry('stale');
    stale.lastRequestAt = Date.now() - 10_000;
    let freshClosed = false, staleClosed = false;
    fresh.transport.close = async () => { freshClosed = true; };
    stale.transport.close = async () => { staleClosed = true; };
    router.set('fresh', fresh);
    router.set('stale', stale);
    const evicted: string[] = [];
    await router.evictIdleSessions(5_000, { onEvict: (id) => evicted.push(id) });
    expect(evicted).toEqual(['stale']);
    expect(staleClosed).toBe(true);
    expect(freshClosed).toBe(false);
    expect(router.size).toBe(1);
  });
});
