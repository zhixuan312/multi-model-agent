const URL_REGEX = /\bhttps?:\/\/[^\s'"<>()]+/gi;

const FORBIDDEN_HOST_CHARS = /[\/:@?#]/;
const IPV4_LITERAL = /^(\d{1,3}\.){3}\d{1,3}$/;
const IPV6_LITERAL = /^\[?[0-9a-fA-F:]+\]?$/;

/**
 * Validate and canonicalize a hostname string. Returns the canonical
 * (lowercase, IDNA-encoded) form or null if the input is not a valid
 * DNS FQDN. Mirrors the HostString rules in config/schema.ts as a
 * defense-in-depth layer: even though ResearchConfigSchema already
 * validates fetchAllowlistExtra via HostString, this function ensures
 * that any caller of buildHostAllowlist — including callers that bypass
 * schema parsing — cannot inject non-FQDN entries with "extra" provenance.
 */
function canonicalizeHostname(raw: string): string | null {
  if (FORBIDDEN_HOST_CHARS.test(raw)) return null;
  if (IPV4_LITERAL.test(raw) || IPV6_LITERAL.test(raw)) return null;
  // Strip trailing dot (DNS root label) — example.com. ≡ example.com
  const stripped = raw.endsWith('.') ? raw.slice(0, -1) : raw;
  if (stripped.length === 0) return null;
  let canonical: string;
  try {
    canonical = new URL(`https://${stripped}`).hostname;
  } catch {
    return null;
  }
  const labels = canonical.split('.');
  if (labels.length < 2) return null;
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) return null;
    if (label.startsWith('-') || label.endsWith('-')) return null;
  }
  return canonical;
}

export function extractURLHosts(strings: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of strings) {
    const matches = s.match(URL_REGEX) ?? [];
    for (const m of matches) {
      try {
        const u = new URL(m);
        if (!u.hostname) continue;
        const canonical = canonicalizeHostname(u.hostname);
        if (canonical === null) continue;
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
 *
 * Both sources are validated through canonicalizeHostname; invalid entries
 * (IP literals, single-label names, malformed hostnames) are silently
 * skipped. This is defense-in-depth: even though ResearchConfigSchema
 * validates fetchAllowlistExtra via HostString, this function does not
 * trust callers to have done so.
 */
export function buildHostAllowlist(input: AllowlistInput): HostAllowlist {
  const map = new Map<string, AllowlistProvenance>();
  for (const h of extractURLHosts(input.userSources)) {
    map.set(h, 'user_source');
  }
  for (const h of input.fetchAllowlistExtra) {
    const canonical = canonicalizeHostname(h);
    if (canonical !== null) {
      map.set(canonical, 'extra');
    }
  }
  return map;
}
