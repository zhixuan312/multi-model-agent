import { isIP } from 'node:net';

const URL_REGEX = /\bhttps?:\/\/[^\s'"<>()]+/gi;

const FORBIDDEN_HOST_CHARS = /[\/:@?#]|:\/\//;
const MAX_HOSTNAME_LENGTH = 253;
const TRAILING_URL_PUNCTUATION = /[.,;:!?]+$/;

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
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_HOSTNAME_LENGTH) return null;
  if (FORBIDDEN_HOST_CHARS.test(trimmed)) return null;
  // Strip trailing dot (DNS root label) — example.com. ≡ example.com
  const stripped = trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed;
  if (stripped.length === 0 || stripped.length > MAX_HOSTNAME_LENGTH) return null;
  let canonical: string;
  try {
    canonical = new URL(`https://${stripped}`).hostname;
  } catch {
    return null;
  }
  if (canonical.length === 0 || canonical.length > MAX_HOSTNAME_LENGTH) return null;
  if (isIP(canonical) !== 0) return null;
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
        const candidate = m.replace(TRAILING_URL_PUNCTUATION, '');
        const u = new URL(candidate);
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
 * (IP literals, single-label names, malformed hostnames, overlong hosts)
 * are silently skipped. This mirrors ResearchConfigSchema's HostString
 * canonicalization as defense-in-depth for callers that have not parsed
 * configuration first; silent skipping preserves URL-extraction behavior
 * for untrusted userSources while keeping this builder non-throwing.
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
