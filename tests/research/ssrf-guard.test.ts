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
    ['172.16.5.5',          'private'],
    ['192.168.1.1',         'private'],
    ['fc00::1',             'private'],   // locally-assigned ULA half — always-reject in spec, classified 'private' here
    ['fd12:3456:789a::1',   'private'],   // randomly-assigned ULA half — opt-in-skippable
    ['100.64.0.1',          'private'],   // RFC 6598 CGNAT — never publicly routable
    ['100.127.255.254',     'private'],   // CGNAT range upper boundary
    ['169.254.169.254',     'link-local-or-metadata'],
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
    ['224.0.0.1',           'multicast'],
    ['ff00::1',             'multicast'],
    ['255.255.255.255',     'broadcast-or-reserved'],
    ['240.0.0.1',           'broadcast-or-reserved'],
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
});
