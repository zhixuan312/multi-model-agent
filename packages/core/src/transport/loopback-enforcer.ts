import * as net from 'node:net';

/**
 * Spec C1 LoopbackEnforcer — two-check enforcement against DNS rebinding:
 *   (a) IP-level: socket remote address must be loopback (127/8 or ::1)
 *   (b) Host/Origin header: must be localhost / 127.0.0.1 / [::1]
 *
 * The IP check defends against external network access; the header check
 * defends against rebinding attacks where a malicious site resolves a
 * controlled hostname to 127.0.0.1.
 */

/**
 * Returns true iff the given address string refers to the loopback interface.
 * Accepts all forms Node's socket layer surfaces:
 *   - IPv4 loopback (any 127.0.0.0/8 address): 127.0.0.1, 127.0.1.1, etc.
 *   - IPv6 loopback: ::1
 *   - IPv4-mapped IPv6 loopback: ::ffff:127.0.0.1
 *   - Hostname: localhost
 */
export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  if (addr === 'localhost') return true;
  const clean = addr.split('%')[0];
  const kind = net.isIP(clean);
  if (kind === 4) {
    return clean.startsWith('127.');
  }
  if (kind === 6) {
    if (clean === '::1') return true;
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
 * Returns true iff the request should be rejected because the socket
 * remote address is not loopback.
 */
export function shouldRejectNonLoopback(remoteAddress: string | undefined): boolean {
  return !isLoopbackAddress(remoteAddress);
}

const ALLOWED_HOST_LITERALS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Validates the Host (or Origin) header against a small allowlist.
 * Strips any port suffix before comparing.
 */
export function isAllowedHostHeader(host: string | undefined): boolean {
  if (!host) return false;
  // host may be "localhost:7337" or "[::1]:7337" — strip port
  let h = host.trim();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    if (end < 0) return false;
    h = h.slice(0, end + 1);
  } else {
    const colon = h.indexOf(':');
    if (colon >= 0) h = h.slice(0, colon);
  }
  return ALLOWED_HOST_LITERALS.has(h.toLowerCase());
}
