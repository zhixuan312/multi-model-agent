import { isIP } from 'node:net';
import { promises as dns } from 'node:dns';

export type IPClass =
  | 'public'
  | 'loopback'
  | 'private'
  | 'link-local-or-metadata'
  | 'unspecified'
  | 'multicast'
  | 'broadcast-or-reserved';

export class SsrfBlocked extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'SsrfBlocked';
  }
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => Number.isNaN(p) || p < 0 || p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

const inRange = (n: number, base: string, mask: number): boolean => {
  const b = ipv4ToInt(base);
  if (b === null) return false;
  const m = mask === 0 ? 0 : (~0 << (32 - mask)) >>> 0;
  return (n & m) === (b & m);
};

const IPV4_SPECIAL_RANGES: Array<[base: string, mask: number, klass: IPClass]> = [
  ['0.0.0.0', 8, 'unspecified'],
  ['127.0.0.0', 8, 'loopback'],
  ['10.0.0.0', 8, 'private'],
  ['172.16.0.0', 12, 'private'],
  ['192.168.0.0', 16, 'private'],
  ['100.64.0.0', 10, 'private'], // RFC 6598 CGNAT; opt-in allowable with private hosts.
  ['169.254.0.0', 16, 'link-local-or-metadata'],
  // IANA IPv4 special-purpose ranges that are not normal public internet destinations.
  ['192.0.0.0', 24, 'broadcast-or-reserved'],
  ['192.0.2.0', 24, 'broadcast-or-reserved'], // TEST-NET-1
  ['198.18.0.0', 15, 'broadcast-or-reserved'], // benchmarking
  ['198.51.100.0', 24, 'broadcast-or-reserved'], // TEST-NET-2
  ['203.0.113.0', 24, 'broadcast-or-reserved'], // TEST-NET-3
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'broadcast-or-reserved'],
];

/**
 * Extract a 32-bit unsigned int from a 4-hex-group region of an expanded IPv6
 * address (used for IPv4-mapped and 6to4 embedded-IPv4 extraction).
 *
 * Returns null on malformed input. The caller stringifies back to dotted-quad
 * via classifyIP, so we don't need pretty formatting here.
 */
function expandIPv6Groups(addr: string): string[] | null {
  // Split on '::' (at most once); pad missing groups with '0'.
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = 8 - (left.length + right.length);
  if (fill < 0) return null;
  if (halves.length === 1 && left.length !== 8) return null;
  return [...left, ...Array(fill).fill('0'), ...right]
    .map((g) => g.padStart(4, '0').toLowerCase());
}

function groupsToIPv4(g: string[], startGroup: number): string | null {
  if (g.length < startGroup + 2) return null;
  const hi = parseInt(g[startGroup]!, 16);
  const lo = parseInt(g[startGroup + 1]!, 16);
  if (Number.isNaN(hi) || Number.isNaN(lo)) return null;
  const a = (hi >> 8) & 0xff, b = hi & 0xff, c = (lo >> 8) & 0xff, d = lo & 0xff;
  return `${a}.${b}.${c}.${d}`;
}

export function classifyIP(ip: string): IPClass {
  const lower = ip.toLowerCase();

  // Cloud-metadata ULAs (informal cloud-provider conventions; not IANA-registered)
  // Checked before isIP because these patterns may use non-hex tokens like 'gcp'/'az'.
  if (/^fd00:(ec2|gcp|az):/.test(lower))       return 'link-local-or-metadata';

  const v = isIP(ip);
  if (v === 4) {
    const n = ipv4ToInt(ip);
    if (n === null) return 'broadcast-or-reserved';
    if (n === 0xffffffff) return 'broadcast-or-reserved';
    for (const [base, mask, klass] of IPV4_SPECIAL_RANGES) {
      if (inRange(n, base, mask)) return klass;
    }
    return 'public';
  }
  if (v === 6) {
    if (lower === '::')                          return 'unspecified';
    if (lower === '::1')                         return 'loopback';

    // IPv4-mapped IPv6 (::ffff:a.b.c.d or ::ffff:HEXHEX:HEXHEX) — recurse on embedded IPv4
    const v4mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (v4mapped) return classifyIP(v4mapped[1]!);
    const groups = expandIPv6Groups(lower);
    if (groups && groups[0] === '0000' && groups[1] === '0000' && groups[2] === '0000'
        && groups[3] === '0000' && groups[4] === '0000' && groups[5] === 'ffff') {
      const embedded = groupsToIPv4(groups, 6);
      if (embedded) return classifyIP(embedded);
    }

    // 6to4 (2002::/16) — embeds IPv4 at bits 16–47 (groups 1 + 2). Recurse.
    if (groups && groups[0] === '2002') {
      const embedded = groupsToIPv4(groups, 1);
      if (embedded) return classifyIP(embedded);
    }

    // fe80::/10 link-local (covers fe80–febf when interpreted strictly).
    if (groups && /^fe[89ab]/.test(groups[0]!))  return 'link-local-or-metadata';

    // Locally-assigned ULA (fc00::/8) and randomly-assigned ULA (fd00::/8) → 'private'.
    // The opt-in policy in spec §7.1 step 8 distinguishes these two halves;
    // classifyIP only reports membership in the conditional-reject set.
    if (groups && (groups[0]!.startsWith('fc') || groups[0]!.startsWith('fd'))) {
      return 'private';
    }

    if (lower.startsWith('ff'))                  return 'multicast';
    // IANA IPv6 special-purpose ranges that are not normal public internet destinations.
    if (groups && groups[0] === '2001' && groups[1] === '0db8') return 'broadcast-or-reserved';
    if (groups && groups[0] === '2001' && /^0[0-1]/.test(groups[1] ?? '')) return 'broadcast-or-reserved';
    // Note: `fec0::/10` was a deprecated site-local block (RFC 3879). Modern
    // unicast addresses outside fc00::/7 (e.g. `fec1::1`) are **routable**
    // under current IANA allocations — classify as public, NOT link-local.
    return 'public';
  }
  return 'broadcast-or-reserved';
}

export interface ResolveOptions {
  resolve?: (host: string) => Promise<string[]>;     // injectable for tests
  allowPrivateForHost: boolean;
}

const isNoRecordsError = (error: unknown): boolean => {
  const code = (error as { code?: unknown })?.code;
  return code === 'ENODATA' || code === 'ENOTFOUND' || code === 'ESERVFAIL';
};

const defaultResolve = async (host: string): Promise<string[]> => {
  const [v4, v6] = await Promise.allSettled([
    dns.resolve4(host),
    dns.resolve6(host),
  ]);
  const results: string[] = [];
  if (v4.status === 'fulfilled') results.push(...v4.value);
  if (v6.status === 'fulfilled') results.push(...v6.value);
  if (results.length > 0) return results;
  const failures = [v4, v6].filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failures.length > 0 && failures.some((r) => !isNoRecordsError(r.reason))) {
    throw new Error('DNS resolution failed');
  }
  return results;
};

const BLOCKED_CLASSES_STRICT = new Set<IPClass>([
  'loopback',
  'private',
  'link-local-or-metadata',
  'unspecified',
  'multicast',
  'broadcast-or-reserved',
]);

const BLOCKED_CLASSES_PERMISSIVE = new Set<IPClass>([
  'loopback',
  'link-local-or-metadata',
  'unspecified',
  'multicast',
  'broadcast-or-reserved',
]);

function isLocallyAssignedULA(ip: string): boolean {
  if (isIP(ip) !== 6) return false;
  const groups = expandIPv6Groups(ip.toLowerCase());
  if (!groups) return false;
  return groups[0]!.startsWith('fc');
}

export async function resolveAndPin(
  host: string,
  options: ResolveOptions,
): Promise<string> {
  const resolve = options.resolve ?? defaultResolve;
  let ips: string[];
  try {
    ips = await resolve(host);
  } catch {
    throw new SsrfBlocked(
      'web_fetch_dns_resolution_failed',
      `web_fetch_dns_resolution_failed: DNS resolution failed for host '${host}'`,
    );
  }

  if (ips.length === 0) {
    throw new SsrfBlocked(
      'web_fetch_no_addresses',
      `web_fetch_no_addresses: no addresses resolved for host '${host}'`,
    );
  }

  const blocked = options.allowPrivateForHost
    ? BLOCKED_CLASSES_PERMISSIVE
    : BLOCKED_CLASSES_STRICT;

  for (const ip of ips) {
    const klass = classifyIP(ip);
    if (blocked.has(klass)) {
      throw new SsrfBlocked(
        'web_fetch_private_ip_blocked',
        `web_fetch_private_ip_blocked: resolved IP class '${klass}' is not allowed for host '${host}'`,
      );
    }
    // fc00::/8 locally-assigned ULA is always-reject, even in permissive mode
    if (isLocallyAssignedULA(ip)) {
      throw new SsrfBlocked(
        'web_fetch_private_ip_blocked',
        `web_fetch_private_ip_blocked: resolved IP is locally-assigned ULA (fc00::/8), which is never allowed for host '${host}'`,
      );
    }
  }

  return ips[0]!;
}
