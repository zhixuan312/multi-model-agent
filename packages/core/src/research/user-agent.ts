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

// Test seam — exported only for unit tests; do not call from production code.
export async function _resetForTests(fakePkg: { version?: unknown }): Promise<string> {
  return compose(fakePkg.version);
}
