/**
 * print-token.ts — `mma print-token` subcommand.
 *
 * Reads the bearer auth token and prints it to stdout.
 * Env override (MMA_AUTH_TOKEN) wins over any file.
 * Missing file → prints an error message to stderr and exits 1.
 *
 * Usage:
 *   mma print-token [--config <path>]
 */
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { expandHome } from '../expand-home.js';

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
  const envToken = (env['MMA_AUTH_TOKEN'] ?? '').trim();
  if (envToken.length > 0) {
    stdout(envToken + '\n');
    return 0;
  }

  // Fall back to token file
  const rawTokenFile = deps.tokenFile ?? path.join(homeDir, '.mma', 'auth-token');
  const tokenFile = expandHome(rawTokenFile, homeDir);

  try {
    const token = fs.readFileSync(tokenFile, 'utf-8').trim();
    if (token.length === 0) {
      stderr(`mma: token file is empty: ${tokenFile}\n`);
      return 1;
    }
    stdout(token + '\n');
    return 0;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      stderr(
        `mma: token file not found: ${tokenFile}\n` +
        `Run 'mma serve' once to generate a token, or set MMA_AUTH_TOKEN.\n`,
      );
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      stderr(`mma: cannot read token file ${tokenFile}: ${msg}\n`);
    }
    return 1;
  }
}
