import { describe, it, expect } from 'vitest';
import { isLoopbackAddress } from '../../packages/mcp/src/http/loopback.js';

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
