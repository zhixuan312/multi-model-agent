import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Expand a leading `~/` in a path to the home directory.
 *
 * Single implementation shared by the HTTP auth token resolver (http/auth.ts)
 * and the CLI (cli/print-token.ts). `homeDir` defaults to os.homedir(); callers
 * that already resolved a home dir (e.g. a test-injected one) pass it explicitly.
 */
export function expandHome(p: string, homeDir: string = homedir()): string {
  if (p.startsWith('~/')) return join(homeDir, p.slice(2));
  return p;
}
