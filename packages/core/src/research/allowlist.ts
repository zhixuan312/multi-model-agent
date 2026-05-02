const URL_REGEX = /\bhttps?:\/\/[^\s'"<>()]+/gi;

// Reuse the same FQDN regex as HostString in config/schema.ts: must have ≥1 dot.
const FQDN_RE = /^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/;

export function extractURLHosts(strings: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of strings) {
    const matches = s.match(URL_REGEX) ?? [];
    for (const m of matches) {
      try {
        const u = new URL(m);
        if (!u.hostname) continue;
        // Reject IP literals — only DNS hosts may enter the allowlist.
        if (/^\d{1,3}(\.\d{1,3}){3}$/.test(u.hostname)) continue;
        if (u.hostname.startsWith('[')) continue;       // ipv6 literal
        const canonical = u.hostname.toLowerCase();
        // Match HostString's FQDN constraint — `no-tld` (single label, no dot) is rejected.
        if (!FQDN_RE.test(canonical)) continue;
        if (!seen.has(canonical)) {
          seen.add(canonical);
          out.push(canonical);
        }
      } catch {
        // malformed URL — silently skip
      }
    }
  }
  return out;
}

export interface AllowlistInput {
  fetchAllowlistExtra: readonly string[];
  userSources: readonly string[];
}

export type AllowlistProvenance = 'extra' | 'user_source';
export type HostAllowlist = ReadonlyMap<string, AllowlistProvenance>;

/**
 * Build the per-task fetch allowlist as a provenance-aware map. Per spec
 * §6.2 / §7.1 step 8, the private-network opt-in is gated on
 * `provenance === 'extra'` — only operator-declared hosts in
 * `fetchAllowlistExtra` are eligible, never hosts harvested from
 * `userSources`. Build order: userSources first (lower precedence), then
 * fetchAllowlistExtra overwrites — so collisions resolve to the operator's
 * deliberate intent.
 */
export function buildHostAllowlist(input: AllowlistInput): HostAllowlist {
  const map = new Map<string, AllowlistProvenance>();
  for (const h of extractURLHosts(input.userSources)) {
    map.set(h, 'user_source');
  }
  for (const h of input.fetchAllowlistExtra) {
    map.set(h.toLowerCase(), 'extra');
  }
  return map;
}
