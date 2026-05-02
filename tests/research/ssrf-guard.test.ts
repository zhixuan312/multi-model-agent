import { describe, expect, it, vi } from 'vitest';
import {
  classifyIP, IPClass,
  resolveAndPin, SsrfBlocked,
} from '../../packages/core/src/research/ssrf-guard.js';

describe('classifyIP', () => {
  const cases: Array<[string, IPClass]> = [
    ['127.0.0.1',           'loopback'],
    ['::1',                 'loopback'],
    ['10.0.0.1',            'private'],
    ['172.15.255.255',      'public'],
    ['172.16.0.0',          'private'],
    ['172.16.5.5',          'private'],
    ['172.31.255.255',      'private'],
    ['172.32.0.0',          'public'],
    ['192.168.1.1',         'private'],
    ['fc00::1',             'private'],   // locally-assigned ULA half — always-reject in spec, classified 'private' here
    ['fd12:3456:789a::1',   'private'],   // randomly-assigned ULA half — opt-in-skippable
    ['100.63.255.255',      'public'],
    ['100.64.0.0',          'private'],   // RFC 6598 CGNAT — opt-in allowable with private hosts
    ['100.64.0.1',          'private'],
    ['100.127.255.255',     'private'],   // CGNAT range upper boundary
    ['100.128.0.0',         'public'],
    ['169.254.0.0',         'link-local-or-metadata'],
    ['169.254.169.254',     'link-local-or-metadata'],
    ['169.254.255.255',     'link-local-or-metadata'],
    ['fe80::1',             'link-local-or-metadata'],
    ['fec1::1',             'public'],    // fec0::/10 was deprecated; "fec" prefix outside that block is unicast — classify by routable status
    ['fd00:ec2::254',       'link-local-or-metadata'],  // AWS metadata ULA carve-out
    ['fd00:gcp::1',         'link-local-or-metadata'],
    ['fd00:az::1',          'link-local-or-metadata'],
    // IPv4-mapped IPv6 — recursively classifies embedded v4
    ['::ffff:127.0.0.1',    'loopback'],
    ['::ffff:10.0.0.1',     'private'],
    ['::ffff:8.8.8.8',      'public'],
    // 6to4 — extracts embedded v4 and classifies
    ['2002:c0a8:0101::',    'private'],   // embeds 192.168.1.1
    ['2002:0808:0808::',    'public'],    // embeds 8.8.8.8
    ['2002:7f00:0001::',    'loopback'],  // embeds 127.0.0.1
    ['0.0.0.0',             'unspecified'],
    ['::',                  'unspecified'],
    ['192.0.0.1',           'broadcast-or-reserved'],
    ['192.0.2.1',           'broadcast-or-reserved'], // TEST-NET-1
    ['198.18.0.1',          'broadcast-or-reserved'], // benchmarking
    ['198.51.100.1',        'broadcast-or-reserved'], // TEST-NET-2
    ['203.0.113.1',         'broadcast-or-reserved'], // TEST-NET-3
    ['224.0.0.0',           'multicast'],
    ['224.0.0.1',           'multicast'],
    ['239.255.255.255',     'multicast'],
    ['ff00::1',             'multicast'],
    ['255.255.255.255',     'broadcast-or-reserved'],
    ['240.0.0.0',           'broadcast-or-reserved'],
    ['240.0.0.1',           'broadcast-or-reserved'],
    ['2001:db8::1',         'broadcast-or-reserved'], // documentation
    ['2001::1',             'broadcast-or-reserved'], // special-purpose assignments
    ['8.8.8.8',             'public'],
    ['2606:4700:4700::1111', 'public'],
  ];
  for (const [ip, klass] of cases) {
    it(`${ip} → ${klass}`, () => expect(classifyIP(ip)).toBe(klass));
  }
});

describe('resolveAndPin', () => {
  it('returns pinned IP when all resolved IPs are public', async () => {
    const fakeResolve = vi.fn().mockResolvedValue(['8.8.8.8']);
    const pinned = await resolveAndPin('example.com', { resolve: fakeResolve, allowPrivateForHost: false });
    expect(pinned).toBe('8.8.8.8');
  });

  it('throws SsrfBlocked when any resolved IP is private (without opt-in)', async () => {
    const fakeResolve = vi.fn().mockResolvedValue(['10.0.0.1']);
    await expect(
      resolveAndPin('intranet', { resolve: fakeResolve, allowPrivateForHost: false }),
    ).rejects.toThrow(SsrfBlocked);
    await expect(
      resolveAndPin('intranet', { resolve: fakeResolve, allowPrivateForHost: false }),
    ).rejects.toThrow(/web_fetch_private_ip_blocked/);
  });

  it('with allowPrivateForHost=true allows private IP but still blocks loopback/metadata', async () => {
    const fakeResolveOk = vi.fn().mockResolvedValue(['10.0.0.1']);
    const pinned = await resolveAndPin('intranet', { resolve: fakeResolveOk, allowPrivateForHost: true });
    expect(pinned).toBe('10.0.0.1');

    const fakeResolveLoopback = vi.fn().mockResolvedValue(['127.0.0.1']);
    await expect(
      resolveAndPin('intranet', { resolve: fakeResolveLoopback, allowPrivateForHost: true }),
    ).rejects.toThrow(/web_fetch_private_ip_blocked/);

    const fakeResolveMeta = vi.fn().mockResolvedValue(['169.254.169.254']);
    await expect(
      resolveAndPin('intranet', { resolve: fakeResolveMeta, allowPrivateForHost: true }),
    ).rejects.toThrow(/web_fetch_private_ip_blocked/);
  });

  it('rejects when ANY resolved IP fails (multi-A-record case)', async () => {
    const fakeResolve = vi.fn().mockResolvedValue(['8.8.8.8', '127.0.0.1']);
    await expect(
      resolveAndPin('mixed', { resolve: fakeResolve, allowPrivateForHost: false }),
    ).rejects.toThrow(/web_fetch_private_ip_blocked/);
  });

  it('does not include resolved IPs in error message (no internal-topology leak)', async () => {
    const fakeResolve = vi.fn().mockResolvedValue(['10.0.0.1']);
    let caught: unknown;
    try { await resolveAndPin('intranet', { resolve: fakeResolve, allowPrivateForHost: false }); }
    catch (e) { caught = e; }
    expect(String(caught)).not.toContain('10.0.0.1');
  });

  it('throws when resolver returns empty array', async () => {
    const fakeResolve = vi.fn().mockResolvedValue([]);
    await expect(
      resolveAndPin('no-records', { resolve: fakeResolve, allowPrivateForHost: false }),
    ).rejects.toThrow(/web_fetch_no_addresses/);
  });

  it('preserves resolver failures separately from no-address results', async () => {
    const fakeResolve = vi.fn().mockRejectedValue(new Error('SERVFAIL 10.0.0.1'));
    let caught: unknown;
    try { await resolveAndPin('broken.example', { resolve: fakeResolve, allowPrivateForHost: false }); }
    catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(SsrfBlocked);
    expect((caught as SsrfBlocked).code).toBe('web_fetch_dns_resolution_failed');
    expect(String(caught)).not.toContain('10.0.0.1');
  });

  it('with allowPrivateForHost=true allows fd00::/8 ULA (non-cloud-metadata)', async () => {
    const fakeResolve = vi.fn().mockResolvedValue(['fd12:3456:789a::1']);
    const pinned = await resolveAndPin('ula-host', { resolve: fakeResolve, allowPrivateForHost: true });
    expect(pinned).toBe('fd12:3456:789a::1');
  });

  it('with allowPrivateForHost=true rejects fc00::/8 (locally-assigned ULA always blocked)', async () => {
    const fakeResolve = vi.fn().mockResolvedValue(['fc00::1']);
    await expect(
      resolveAndPin('local-ula', { resolve: fakeResolve, allowPrivateForHost: true }),
    ).rejects.toThrow(/web_fetch_private_ip_blocked/);
  });

  it('with allowPrivateForHost=true allows CGNAT 100.64.0.0/10', async () => {
    const fakeResolve = vi.fn().mockResolvedValue(['100.64.0.1']);
    const pinned = await resolveAndPin('cgnat-host', { resolve: fakeResolve, allowPrivateForHost: true });
    expect(pinned).toBe('100.64.0.1');
  });

  it('with allowPrivateForHost=true allows RFC1918 192.168.x.x', async () => {
    const fakeResolve = vi.fn().mockResolvedValue(['192.168.1.100']);
    const pinned = await resolveAndPin('rfc1918-host', { resolve: fakeResolve, allowPrivateForHost: true });
    expect(pinned).toBe('192.168.1.100');
  });
});
