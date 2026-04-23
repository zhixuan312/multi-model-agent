import { describe, it, expect } from 'vitest';
import { isLoopbackAddress, shouldRejectNonLoopback } from '../../packages/server/src/http/loopback.js';

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
