#!/usr/bin/env node
/**
 * CLI entry point for `mmagent` / `multi-model-agent`.
 *
 * Usage:
 *   mmagent serve [--config <path>]
 *   mmagent --help
 *   mmagent --version
 *
 * Config discovery order (highest priority → lowest):
 *   1. --config <path>          (explicit flag)
 *   2. $MMAGENT_CONFIG env var
 *   3. CWD/.multi-model-agent.json
 *   4. ~/.multi-model/config.json
 *
 * All side effects (process.exit, stdout/stderr writes) are contained in the
 * bootstrap at the bottom of this file. The internal `main()` function is
 * exported so it can be unit-tested without spawning subprocesses.
 *
 * Signal lifecycle is owned by `serve.ts` — this module delegates to
 * `startServe()` which registers SIGTERM/SIGINT handlers and manages process.exit.
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import minimist, { type ParsedArgs } from 'minimist';
import {
  loadConfigFromFile,
  type MultiModelConfig,
} from '@zhixuan92/multi-model-agent-core';
import { startServe } from './serve.js';
import { printToken } from './print-token.js';
import { runStatus, buildServerUrl } from './status.js';
import { main as installSkillMain } from './install-skill.js';
import { runInfo } from './info.js';
import { runUpdateSkills } from './update-skills.js';
import { runLogs } from './logs.js';

/**
 * Minimal I/O dependencies — allows tests to intercept stdout/stderr and
 * override process.argv / process.exit.
 */
export interface CliDeps {
  /**
   * argv[0..] (not including node path or script path) passed to minimist.
   * Defaults to process.argv.slice(2).
   */
  argv?: () => string[];
  /**
   * Current working directory. Defaults to process.cwd().
   * Used only for resolving the CWD/.multi-model-agent.json discovery path.
   */
  cwd?: () => string;
  /**
   * Home directory. Defaults to os.homedir().
   * Used only for resolving the ~/.multi-model/config.json discovery path.
   */
  homeDir?: () => string;
  /**
   * Environment variable accessor. Defaults to process.env.
   */
  env?: () => Record<string, string | undefined>;
  /** Write to stdout. Defaults to process.stdout.write.bind(process.stdout). */
  stdout?: (s: string) => boolean;
  /** Write to stderr. Defaults to process.stderr.write.bind(process.stderr). */
  stderr?: (s: string) => boolean;
  /** Exit the process. Defaults to process.exit. */
  exit?: (code: number) => never;
}

/** Parse minimist args from an argv array. */
export function parseArgs(argv: string[]): ParsedArgs {
  return minimist(argv, {
    string: ['config', 'batch'],
    boolean: ['help', 'version', 'json', 'dry-run', 'if-exists', 'silent', 'best-effort', 'follow'],
    alias: { config: 'c', help: 'h', version: 'v', json: 'j' },
    // Note: stopEarly is NOT set. With stopEarly:true, options after the first
    // positional argument (the subcommand) would be silently dropped. E.g.
    // `mmagent serve --config ./config.json` would lose --config.
  });
}

/**
 * Build the ordered list of config-file candidates from discovery sources.
 * Returns an array of resolved paths; callers filter for existence and
 * iterate in priority order. This single builder ensures that
 * resolveConfigPath() and loadConfig() cannot drift apart.
 */
function buildCandidatePaths(
  explicit: string | undefined,
  env: Record<string, string | undefined>,
  cwd: string,
  home: string,
): string[] {
  const paths: string[] = [];

  if (explicit) paths.push(explicit);

  const envVal = (env['MMAGENT_CONFIG'] ?? '').trim();
  if (envVal) paths.push(envVal);

  paths.push(path.join(cwd, '.multi-model-agent.json'));

  paths.push(path.join(home, '.multi-model', 'config.json'));

  return paths;
}

/**
 * Resolve the config file path using the discovery order:
 *   1. --config <path>   (explicit flag)
 *   2. $MMAGENT_CONFIG   (env var)
 *   3. CWD/.multi-model-agent.json
 *   4. ~/.multi-model/config.json
 *
 * Returns the first path that exists, or undefined if none exist.
 * Does NOT validate or parse the file — caller uses loadConfigFromFile().
 */
export function resolveConfigPath(
  explicit: string | undefined,
  env: Record<string, string | undefined>,
  cwd: string,
  home: string,
): string | undefined {
  for (const p of buildCandidatePaths(explicit, env, cwd, home)) {
    if (p && fs.existsSync(p)) return p;
  }
  return undefined;
}

/**
 * Load config using the discovery order.
 * Tries each candidate in priority order and returns the first successfully
 * loaded config. Returns an error listing all attempted paths if none are found
 * or every found file is unreadable/invalid.
 */
export async function loadConfig(
  explicitPath: string | undefined,
  deps: Pick<CliDeps, 'cwd' | 'homeDir' | 'env'>,
): Promise<MultiModelConfig> {
  const cwd = deps.cwd?.() ?? process.cwd();
  const home = deps.homeDir?.() ?? os.homedir();
  const env = deps.env?.() ?? process.env;

  const attempted: string[] = [];

  for (const p of buildCandidatePaths(explicitPath, env, cwd, home)) {
    if (!p) {
      attempted.push('<source: not set>');
      continue;
    }
    attempted.push(p);
    if (!fs.existsSync(p)) continue;
    try {
      return await loadConfigFromFile(p);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Config error (${p}): ${msg}`);
    }
  }

  throw new Error(
    `No config file found. Tried:\n${attempted.join('\n')}\n` +
    `Set one via --config, $MMAGENT_CONFIG, or place it at a default location above.`,
  );
}

const HELP_TEXT = `\
mmagent — multi-model-agent HTTP server

Usage:
  mmagent [command] [options]

Commands:
  serve            Start the HTTP server (default)
  print-token      Print the bearer auth token to stdout
  info             Print config + daemon identity (works offline)
  status           Show server status (requires a running server)
  install-skill    Install or uninstall a skill for an AI client
  update-skills    Re-copy installed skills from the shipped bundle
  logs             Tail the diagnostic log (use --follow / --batch=<id>)

Global options:
  --config, -c <path>   Path to config file
  --help, -h            Show this help
  --version, -v         Show version
`;

/**
 * Read the server package version from package.json, walking up from this file.
 */
function readServerVersion(): string {
  try {
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.join(thisDir, '..', '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Main entry point — exported so it can be unit-tested without subprocess spawning.
 *
 * @param deps  I/O dependencies (defaults to real process globals).
 */
export async function main(deps: CliDeps = {}): Promise<void> {
  const argv = deps.argv?.() ?? process.argv.slice(2);
  const stdout = deps.stdout ?? process.stdout.write.bind(process.stdout);
  const stderr = deps.stderr ?? process.stderr.write.bind(process.stderr);
  const exit = deps.exit ?? process.exit.bind(process);

  const opts = parseArgs(argv);
  const positional = opts._ as string[];
  const subcommand = positional[0] ?? 'serve';
  const configArg = typeof opts['config'] === 'string' ? opts['config'] : undefined;

  if (opts['help']) {
    stdout(HELP_TEXT);
    return;
  }

  if (opts['version']) {
    stdout(readServerVersion() + '\n');
    return;
  }

  switch (subcommand) {
    case 'serve': {
      const config = await loadConfig(configArg, deps);
      // startServe() blocks until a signal arrives and exits the process.
      await startServe(config, exit);
      break;
    }
    case 'print-token': {
      const config = await loadConfig(configArg, deps).catch(() => null);
      const tokenFile = config
        ? config.server.auth.tokenFile
        : path.join(deps.homeDir?.() ?? os.homedir(), '.multi-model', 'auth-token');
      const code = printToken({
        homeDir: deps.homeDir?.() ?? os.homedir(),
        tokenFile,
        env: deps.env?.() ?? process.env,
        stdout: deps.stdout,
        stderr: deps.stderr,
      });
      exit(code);
      break;
    }
    case 'status': {
      const jsonFlag = opts['json'] === true;
      const config = await loadConfig(configArg, deps).catch(() => null);
      const home = deps.homeDir?.() ?? os.homedir();
      const tokenFile = config
        ? config.server.auth.tokenFile
        : path.join(home, '.multi-model', 'auth-token');
      const serverUrl = config
        ? buildServerUrl(config.server.bind, config.server.port)
        : buildServerUrl('127.0.0.1', 7337);
      const code = await runStatus({
        serverUrl,
        tokenFile,
        json: jsonFlag,
        env: deps.env?.() ?? process.env,
        homeDir: home,
        stdout: deps.stdout,
        stderr: deps.stderr,
      });
      exit(code);
      break;
    }
    case 'info': {
      const jsonFlag = opts['json'] === true;
      const config = await loadConfig(configArg, deps).catch(() => null);
      if (!config) {
        stderr(`mmagent info: cannot load config. Set --config or $MMAGENT_CONFIG.\n`);
        exit(1);
        break;
      }
      const code = await runInfo({
        cliVersion: readServerVersion(),
        bind: config.server.bind,
        port: config.server.port,
        tokenFile: config.server.auth.tokenFile,
        homeDir: deps.homeDir?.() ?? os.homedir(),
        json: jsonFlag,
        stdout: deps.stdout,
        stderr: deps.stderr,
      });
      exit(code);
      break;
    }
    case 'logs': {
      const config = await loadConfig(configArg, deps).catch(() => null);
      if (!config) {
        stderr(`mmagent logs: cannot load config. Set --config or $MMAGENT_CONFIG.\n`);
        exit(1);
        break;
      }
      const code = await runLogs({
        config,
        homeDir: deps.homeDir?.() ?? os.homedir(),
        follow: opts['follow'] === true,
        batchId: typeof opts['batch'] === 'string' ? opts['batch'] : undefined,
        stdout: deps.stdout,
        stderr: deps.stderr,
      });
      exit(code);
      break;
    }
    case 'update-skills': {
      const code = await runUpdateSkills({
        homeDir: deps.homeDir?.() ?? os.homedir(),
        dryRun: opts['dry-run'] === true,
        json: opts['json'] === true,
        ifExists: opts['if-exists'] === true,
        silent: opts['silent'] === true,
        bestEffort: opts['best-effort'] === true,
        stdout: deps.stdout,
        stderr: deps.stderr,
      });
      exit(code);
      break;
    }
    case 'install-skill': {
      // Forward all argv tokens that come after the subcommand name.
      // minimist with stopEarly:true would have captured them in opts._, but
      // since we don't use stopEarly we need to find the subcommand boundary
      // in the raw argv array and pass everything after it.
      const subCmdIdx = argv.indexOf('install-skill');
      const subArgv = subCmdIdx >= 0 ? argv.slice(subCmdIdx + 1) : positional.slice(1);
      const code = await installSkillMain({
        argv: subArgv,
        homeDir: deps.homeDir?.() ?? os.homedir(),
        stdout: deps.stdout,
        stderr: deps.stderr,
      });
      exit(code);
      break;
    }
    default: {
      stderr(`Unknown command: ${subcommand}\nRun 'mmagent --help' for usage.\n`);
      exit(1);
    }
  }
}

// ── Bootstrap ──────────────────────────────────────────────────────────────

// Only run main() when this module is executed as the CLI entry point.
// Tests import main() directly and pass CliDeps.
function isMain(): boolean {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    // Resolve to absolute path and follow symlinks — npm installs the bin as a
    // symlink in node_modules/.bin/, so argv[1] points at the symlink, not the
    // real file. fs.realpathSync follows the link so it matches import.meta.url.
    const entryPath = import.meta.url.startsWith('file://')
      ? fileURLToPath(import.meta.url)
      : path.resolve(argv1);
    return fs.realpathSync(path.resolve(argv1)) === entryPath;
  } catch {
    return false;
  }
}

if (isMain()) {
  void main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`mmagent: ${msg}\n`);
    process.exit(1);
  });
}

// Re-export for TypeScript consumers.
export type { MultiModelConfig };