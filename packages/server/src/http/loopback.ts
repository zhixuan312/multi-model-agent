import * as net from 'node:net';

/**
 * Returns true iff the given address string refers to the loopback interface.
 * Accepts all forms Node's socket layer surfaces:
 *   - IPv4 loopback (any 127.0.0.0/8 address): 127.0.0.1, 127.0.1.1, etc.
 *   - IPv6 loopback: ::1
 *   - IPv4-mapped IPv6 loopback: ::ffff:127.0.0.1 (and other 127/8 mapped forms)
 *   - Hostname: localhost
 */
export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  if (addr === 'localhost') return true;
  // Strip any scope ID (fe80::1%lo0 style) — rare for loopback but cheap to handle.
  const clean = addr.split('%')[0];
  const kind = net.isIP(clean);
  if (kind === 4) {
    return clean.startsWith('127.');
  }
  if (kind === 6) {
    if (clean === '::1') return true;
    // IPv4-mapped IPv6: ::ffff:A.B.C.D
    const mappedPrefix = '::ffff:';
    if (clean.toLowerCase().startsWith(mappedPrefix)) {
      const v4 = clean.slice(mappedPrefix.length);
      return net.isIPv4(v4) && v4.startsWith('127.');
    }
    return false;
  }
  return false;
}

/**
 * Returns true iff the request should be rejected because it came from a
 * non-loopback address on a loopback-only endpoint.
 *
 * @param remoteAddress The socket remote address (req.socket?.remoteAddress)
 */
export function shouldRejectNonLoopback(remoteAddress: string | undefined): boolean {
  return !isLoopbackAddress(remoteAddress);
}
