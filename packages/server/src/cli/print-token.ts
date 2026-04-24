/**
 * print-token.ts — `mmagent print-token` subcommand.
 *
 * Reads the bearer auth token and prints it to stdout.
 * Env override (MMAGENT_AUTH_TOKEN) wins over any file.
 * Missing file → prints an error message to stderr and exits 1.
 *
 * Usage:
 *   mmagent print-token [--config <path>]
 */
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

/** Expand a leading '~/' to the home directory. */
function expandHome(p: string, homeDir: string): string {
  if (p.startsWith('~/')) return path.join(homeDir, p.slice(2));
  return p;
}

export interface PrintTokenDeps {
  /** Home directory (defaults to os.homedir()). */
  homeDir?: string;
  /** Token file path (already expanded). Overrides config discovery. */
  tokenFile?: string;
  /** Environment variable accessor. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Write to stdout. Defaults to process.stdout.write. */
  stdout?: (s: string) => boolean;
  /** Write to stderr. Defaults to process.stderr.write. */
  stderr?: (s: string) => boolean;
}

/**
 * Read the bearer token and print it to stdout.
 * Returns 0 on success, 1 on error.
 */
export function printToken(deps: PrintTokenDeps = {}): number {
  const homeDir = deps.homeDir ?? os.homedir();
  const env = deps.env ?? process.env;
  const stdout = deps.stdout ?? process.stdout.write.bind(process.stdout);
  const stderr = deps.stderr ?? process.stderr.write.bind(process.stderr);

  // Env override wins
  const envToken = (env['MMAGENT_AUTH_TOKEN'] ?? '').trim();
  if (envToken.length > 0) {
    stdout(envToken + '\n');
    return 0;
  }

  // Fall back to token file
  const rawTokenFile = deps.tokenFile ?? path.join(homeDir, '.multi-model', 'auth-token');
  const tokenFile = expandHome(rawTokenFile, homeDir);

  try {
    const token = fs.readFileSync(tokenFile, 'utf-8').trim();
    if (token.length === 0) {
      stderr(`mmagent: token file is empty: ${tokenFile}\n`);
      return 1;
    }
    stdout(token + '\n');
    return 0;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      stderr(
        `mmagent: token file not found: ${tokenFile}\n` +
        `Run 'mmagent serve' once to generate a token, or set MMAGENT_AUTH_TOKEN.\n`,
      );
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      stderr(`mmagent: cannot read token file ${tokenFile}: ${msg}\n`);
    }
    return 1;
  }
}
