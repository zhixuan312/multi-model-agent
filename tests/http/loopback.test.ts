import { describe, it, expect } from 'bun:test';
import { isLoopbackAddress, shouldRejectNonLoopback, isAllowedHostHeader } from '../../packages/core/src/transport/loopback-enforcer.js';
import { RouteDispatcher } from '../../packages/core/src/transport/route-dispatcher.js';
import { handleRequest, type PipelineConfig } from '../../packages/server/src/http/request-pipeline.js';
import type { RawHandler } from '../../packages/server/src/http/types.js';

describe('isLoopbackAddress', () => {
  it.each([
    ['127.0.0.1', true],
    ['127.0.1.1', true],
    ['127.255.255.254', true],
    ['::1', true],
    ['::ffff:127.0.0.1', true],
    ['::ffff:127.0.1.1', true],
    ['localhost', true],
    ['0.0.0.0', false],
    ['192.168.1.1', false],
    ['10.0.0.1', false],
    ['::ffff:192.168.1.1', false],
    ['2001:db8::1', false],
    ['', false],
    [undefined, false],
  ])('%j → %s', (input, expected) => {
    expect(isLoopbackAddress(input as string | undefined)).toBe(expected);
  });
});

describe('shouldRejectNonLoopback', () => {
  it('returns false for loopback addresses (should NOT reject)', () => {
    expect(shouldRejectNonLoopback('127.0.0.1')).toBe(false);
    expect(shouldRejectNonLoopback('::1')).toBe(false);
    expect(shouldRejectNonLoopback('localhost')).toBe(false);
  });

  it('returns true for non-loopback addresses (should reject)', () => {
    expect(shouldRejectNonLoopback('192.168.1.1')).toBe(true);
    expect(shouldRejectNonLoopback('10.0.0.1')).toBe(true);
    expect(shouldRejectNonLoopback('2001:db8::1')).toBe(true);
  });

  it('returns true for undefined address (should reject)', () => {
    expect(shouldRejectNonLoopback(undefined)).toBe(true);
  });
});

describe('isAllowedHostHeader', () => {
  it.each([
    ['localhost', true],
    ['localhost:7337', true],
    ['127.0.0.1', true],
    ['127.0.0.1:7337', true],
    ['[::1]', true],
    ['[::1]:7337', true],
    ['evil.example.com', false],
    ['evil.example.com:7337', false],
    ['myhostname', false],
    ['', false],
    [undefined, false],
  ])('host %s → allowed=%s', (host, expected) => {
    expect(isAllowedHostHeader(host as string | undefined)).toBe(expected);
  });
});

describe('host-header guard wiring in handleRequest', () => {
  const EMPTY: PipelineConfig = {
    loopbackOnlyPaths: new Set(),
    authExemptPaths: new Set(),
    cwdRequiredPaths: new Set(),
    mainModelRequiredPaths: new Set(),
  };
  const fakeServer = { requestIP: () => ({ address: '127.0.0.1' }) } as never;

  it('returns 403 forbidden_host when Host header is not an allowed loopback host', async () => {
    const router = new RouteDispatcher<RawHandler>();
    router.register('GET', '/dummy', () => new Response('ok', { status: 200 }));
    const req = new Request('http://localhost/dummy', {
      method: 'GET',
      headers: { host: 'evil.example.com' },
    });
    const res = await handleRequest(router as never, 'tok', req, {} as never, EMPTY, fakeServer);
    expect(res.status).toBe(403);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('forbidden_host');
  });
});
