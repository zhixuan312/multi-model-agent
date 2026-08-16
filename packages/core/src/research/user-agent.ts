// Single source of truth for the User-Agent header sent by every outbound
// adapter and Brave HTTP request from this package.
import pkg from '../../package.json' with { type: 'json' };

const SEMVER_RE = /^\d+\.\d+\.\d+/;
const FALLBACK = 'mma-research/0.0.0-unknown';

function compose(version: unknown): string {
  if (typeof version !== 'string' || !SEMVER_RE.test(version)) {
    return FALLBACK;
  }
  return `mma-research/${version.match(SEMVER_RE)![0]}`;
}

export const USER_AGENT: string = compose((pkg as { version?: unknown }).version);

/**
 * Compose a User-Agent from an arbitrary package object — the seam the unit tests use to check
 * the fallback without a real malformed `package.json`.
 *
 * Named `_resetForTests` until this audit, which said it RESETS something. It does not: `compose`
 * is pure, `USER_AGENT` is computed once at module load and this call cannot change it. A reader
 * looking for the state it reset would find none, and a test author might reasonably expect a
 * call here to alter `USER_AGENT` for the rest of the file.
 *
 * Not async either — nothing here awaits.
 */
export function composeUserAgentForTests(fakePkg: { version?: unknown }): string {
  return compose(fakePkg.version);
}
