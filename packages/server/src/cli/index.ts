#!/usr/bin/env node
/**
 * CLI entry point for `mma` (multi-model-agent).
 *
 * Usage:
 *   mma [--config <path>]       # starts the server (serve is the default command)
 *   mma --help
 *   mma --version
 *
 * Config discovery order (highest priority → lowest):
 *   1. --config <path>          (explicit flag)
 *   2. $MMA_CONFIG env var
 *   3. CWD/.mma.json (or .multi-model-agent.json)
 *   4. ~/.mma/config.json
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
import { createInterface } from 'node:readline';
import { lookup as dnsLookup } from 'node:dns/promises';
import { fileURLToPath } from 'node:url';
import { readServerVersion } from '../server-version.js';
import minimist, { type ParsedArgs } from 'minimist';
import {
  loadAuthToken,
  loadConfigFromFile,
  MCP_BRIDGE_CLIENT_IDS,
  type CallerClient,
  type MultiModelConfig,
} from '@zhixuan92/multi-model-agent-core';
import { startServe } from './serve.js';
import { printToken } from './print-token.js';
import { runStatus, buildServerUrl } from './status.js';
import { runInfo } from './info.js';
import { runStop } from './stop.js';
import { runRestart } from './restart.js';
import { runDoctor } from './doctor.js';
import { runUpdate, type PackageManager } from './update.js';
import { expandHome } from '../expand-home.js';
import { runSyncSkills } from './sync-skills.js';
import { runSetup, ttyPrompts, isInteractive } from './setup.js';
import { runDisable, runEnable } from './toggle.js';
import { runLogs } from './logs.js';
import { runTelemetry } from './telemetry.js';
import { runJournalReindex } from './journal-reindex.js';
import { runPlugin } from './plugin.js';
import { runMcpBridge, bufferedLines } from './mcp.js';
import { removeClientRegistration } from '../provisioning/writers/registry.js';
import { CLIENT_CAPABILITIES } from '../provisioning/capability-registry.js';
import { runClientsCommand, runMcpInstallCommand, McpInstallCliError } from './clients.js';
import { runInitiativesImportBootstrap } from './initiative-import-bootstrap.js';
import type { DeclaredClientRoster } from '../provisioning/roster.js';

/**
 * Minimal I/O dependencies — allows tests to intercept stdout/stderr and
 * override process.argv / process.exit.
 */
interface CliDeps {
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
   * Used only for resolving the ~/.mma/config.json discovery path.
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

/**
 * The inputs `stop`, `restart`, `doctor` and `update` all need.
 *
 * Built once, in one place, so the four commands cannot disagree about which
 * daemon they are acting on — the failure the old `pkill` recipe produced every
 * time it matched a different process than the one serving.
 *
 * Returns null when the config cannot be loaded; the caller reports that,
 * because the message names the subcommand.
 */
async function buildLifecycleDeps(
  configArg: string | undefined,
  deps: CliDeps,
): Promise<{
  stateDir: string;
  serverUrl: string;
  token: string;
  homeDir: string;
  cliPath: string;
  logPath: string;
  serveArgs: string[];
  declared: DeclaredClientRoster | undefined;
} | null> {
  const config = await loadConfig(configArg, deps).catch(() => null);
  if (!config) return null;
  const homeDir = deps.homeDir?.() ?? os.homedir();
  let token = '';
  try {
    token = loadAuthToken({ tokenFile: config.server.auth.tokenFile });
  } catch {
    // /status needs it, /health does not. An unreadable token degrades the
    // report rather than blocking a stop the user asked for.
  }
  return {
    stateDir: expandHome(config.server.stateDir, homeDir),
    serverUrl: buildServerUrl(config.server.bind, config.server.port),
    token,
    homeDir,
    // This module IS the CLI entry point, so its own path is the one to
    // re-execute and the one to spawn the daemon from. Deriving it from
    // process.argv[1] would break under a wrapper or a symlinked bin shim.
    cliPath: fileURLToPath(import.meta.url),
    logPath: path.join(homeDir, '.mma', 'serve.log'),
    serveArgs: configArg ? ['--config', configArg] : [],
    declared: (config as unknown as { clients?: DeclaredClientRoster }).clients,
  };
}

/** Parse minimist args from an argv array. */
export function parseArgs(argv: string[]): ParsedArgs {
  return minimist(argv, {
    string: ['config', 'batch', 'client', 'package-manager', 'previous-version', 'stem'],
    boolean: [
      'help', 'version', 'json', 'dry-run', 'if-exists', 'silent', 'best-effort', 'follow', 'log',
      'regenerate-catalog', 'now', 'no-install', 'post-install', 'offline',
    ],
    alias: { config: 'c', help: 'h', version: 'v', json: 'j' },
    // Note: stopEarly is NOT set. With stopEarly:true, options after the first
    // positional argument (the subcommand) would be silently dropped. E.g.
    // `mma serve --config ./config.json` would lose --config.
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

  const envVal = (env['MMA_CONFIG'] ?? '').trim();
  if (envVal) paths.push(envVal);

  paths.push(path.join(cwd, '.mma.json'));
  paths.push(path.join(cwd, '.multi-model-agent.json'));

  paths.push(path.join(home, '.mma', 'config.json'));

  return paths;
}

/**
 * Resolve the config file path using the discovery order:
 *   1. --config <path>   (explicit flag)
 *   2. $MMA_CONFIG   (env var)
 *   3. CWD/.mma.json (or .multi-model-agent.json)
 *   4. ~/.mma/config.json
 *
 * Returns the first path that exists, or undefined if none exist.
 * Does NOT validate or parse the file — caller uses loadConfigFromFile().
 */
function resolveConfigPath(
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
    `Set one via --config, $MMA_CONFIG, or place it at a default location above.`,
  );
}

const HELP_TEXT = `\
mma — multi-model-agent HTTP server

Usage:
  mma [command] [options]

Commands:
  setup            Configure agents + clients interactively (start here; re-run to change anything)
  update           Update everything, then name the applications you must restart
  doctor           Report every version surface and any drift between them (read-only)
  serve            Start the HTTP server (default — just \`mma\` with no command)
  stop             Stop the running daemon and wait for it to exit
  restart          Stop the daemon, start a replacement, wait until it answers
  print-token      Print the bearer auth token to stdout
  info             Print config + daemon identity (works offline)
  status           Show server status (requires a running server)
  sync-skills      Reconcile shipped skills for the declared roster (scripting; mma setup does this for you)
  clients          Show declared/detected/skills/MCP status for every canonical client
  clients --json   Same, as JSON
  mcp              Bridge stdio MCP (e.g. Claude Desktop) to the running daemon
  mcp install <id> Fully provision one client (registration + skills) — see \`mma clients\` for valid IDs
  mcp uninstall    Remove MMA from Claude Desktop's MCP config
  plugin build     Generate a plugin package — --target=claude-code (default) or agent-plugin
  disable          Remove MMA from declared clients and pin them off (survives npm upgrades)
  enable           Declare clients on and (re)provision them (clears a prior \`disable\`)
  logs             Tail the diagnostic log (use --follow / --batch=<id>)
  telemetry        Manage telemetry consent (status|enable|disable|reset-id|dump-queue)
  journal reindex  Rebuild .mma/journal/index.db from markdown nodes (--regenerate-catalog to also rewrite index.md)
  initiatives import-bootstrap --stem <stem>
                   Assisted MMA-INIT-001 bootstrap import of one .mma/ flow stem (idempotent)

Update / lifecycle options:
  --no-install          update: skip the package install (you manage the package yourself)
  --package-manager <m> update: force npm | pnpm | bun instead of inferring one
  --now                 stop/restart: skip the daemon's drain window for in-flight tasks
  --offline             doctor: do not contact the npm registry

Global options:
  --config, -c <path>   Path to config file
  --help, -h            Show this help
  --version, -v         Show version
`;


/**
 * Main entry point — exported so it can be unit-tested without subprocess spawning.
 *
 * @param deps  I/O dependencies (defaults to real process globals).
 */
export async function main(deps: CliDeps = {}): Promise<void> {
  const argv = deps.argv?.() ?? process.argv.slice(2);
  const stdout = deps.stdout ?? process.stdout.write.bind(process.stdout);
  const stderr = deps.stderr ?? process.stderr.write.bind(process.stderr);
  /**
   * `process.exit()` does NOT flush a pending stdout write when stdout is a pipe — it tears the
   * process down mid-drain, so anything past the OS pipe buffer (64 KB on macOS) is silently lost.
   * The MCP stdio bridge writes a `tools/list` frame well over that (~130 KB today), so an Agent
   * Plugin install — the one install path that speaks stdio — received truncated JSON and could
   * not enumerate a single tool. Wait for the drain, then exit.
   *
   * Injected `deps.exit` (tests) is called directly: it is not a real process teardown.
   */
  const exit = deps.exit ?? ((code?: number): never => {
    const out = process.stdout as NodeJS.WriteStream & { writableLength?: number };
    if (out.writableLength && out.writableLength > 0) {
      process.exitCode = code ?? 0;
      out.once('drain', () => process.exit(code));
      // Returning is safe: the caller's `break` unwinds and Node stays alive until the drain
      // fires, because the pending write keeps the event loop referenced.
      return undefined as never;
    }
    return process.exit(code);
  });

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

  // Auto-migrate ~/.multi-model → ~/.mma (one-time, clean cut)
  {
    const home = deps.homeDir?.() ?? os.homedir();
    const oldDir = path.join(home, '.multi-model');
    const newDir = path.join(home, '.mma');
    try {
      const oldStat = fs.lstatSync(oldDir);
      if (oldStat.isSymbolicLink()) {
        fs.unlinkSync(oldDir);
      } else if (oldStat.isDirectory()) {
        const newIsSymlink = fs.existsSync(newDir) && fs.lstatSync(newDir).isSymbolicLink();
        if (newIsSymlink) fs.unlinkSync(newDir);
        if (!fs.existsSync(newDir)) {
          fs.renameSync(oldDir, newDir);
          stderr(`[mma] migrated ~/.multi-model → ~/.mma\n`);
        } else {
          stderr(`[mma] warning: both ~/.multi-model and ~/.mma exist; remove ~/.multi-model manually\n`);
        }
      }
    } catch { /* best-effort */ }
  }

  switch (subcommand) {
    case 'serve': {
      const config = await loadConfig(configArg, deps);
      const resolvedConfigPath = resolveConfigPath(
        configArg,
        deps.env?.() ?? process.env,
        deps.cwd?.() ?? process.cwd(),
        deps.homeDir?.() ?? os.homedir(),
      );
      // Stderr event streaming is always on (4.7.3+; no --verbose flag).
      // --log enables JSONL persistence to ~/.mma/logs/mma-YYYY-MM-DD.jsonl.
      if (opts['log'] === true) {
        if (!config.diagnostics) config.diagnostics = { log: false };
        config.diagnostics.log = true;
      }
      // startServe() blocks until a signal arrives and exits the process.
      await startServe(config, exit, resolvedConfigPath);
      break;
    }
    case 'print-token': {
      const config = await loadConfig(configArg, deps).catch(() => null);
      const tokenFile = config
        ? config.server.auth.tokenFile
        : path.join(deps.homeDir?.() ?? os.homedir(), '.mma', 'auth-token');
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
        : path.join(home, '.mma', 'auth-token');
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
        stderr(`mma info: cannot load config. Set --config or $MMA_CONFIG.\n`);
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
    case 'stop':
    case 'restart':
    case 'doctor':
    case 'update': {
      const lifecycle = await buildLifecycleDeps(configArg, deps);
      if (lifecycle === null) {
        stderr(`mma ${subcommand}: cannot load config. Set --config or $MMA_CONFIG.\n`);
        exit(1);
        break;
      }
      const json = opts['json'] === true;
      let code: number;
      if (subcommand === 'stop') {
        code = await runStop({ ...lifecycle, now_: opts['now'] === true, json, stdout: deps.stdout, stderr: deps.stderr });
      } else if (subcommand === 'restart') {
        code = await runRestart({ ...lifecycle, now_: opts['now'] === true, json, stdout: deps.stdout, stderr: deps.stderr });
      } else if (subcommand === 'doctor') {
        code = await runDoctor({
          ...lifecycle,
          cliVersion: readServerVersion(),
          declared: lifecycle.declared,
          json,
          offline: opts['offline'] === true,
          stdout: deps.stdout,
          stderr: deps.stderr,
        });
      } else {
        const pm = typeof opts['package-manager'] === 'string'
          ? (opts['package-manager'] as PackageManager)
          : undefined;
        code = await runUpdate({
          ...lifecycle,
          cliVersion: readServerVersion(),
          // minimist maps `--no-install` onto the negation of `install`, so read
          // both spellings rather than only the one a user is likely to guess.
          noInstall: opts['no-install'] === true || opts['install'] === false,
          packageManager: pm,
          postInstall: opts['post-install'] === true,
          previousVersion: typeof opts['previous-version'] === 'string' ? opts['previous-version'] : undefined,
          json,
          stdout: deps.stdout,
          stderr: deps.stderr,
        });
      }
      exit(code);
      break;
    }
    case 'logs': {
      const config = await loadConfig(configArg, deps).catch(() => null);
      if (!config) {
        stderr(`mma logs: cannot load config. Set --config or $MMA_CONFIG.\n`);
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
    case 'setup': {
      const homeDir = deps.homeDir?.() ?? os.homedir();
      if (!isInteractive()) {
        // `deps.stderr` is undefined for the real binary — falling back matters,
        // or a piped `mma setup` exits 1 having printed nothing at all.
        const err = deps.stderr ?? process.stderr.write.bind(process.stderr);
        err('mma setup needs an interactive terminal. For scripts use `mma enable --target=<ClientId>`.\n');
        exit(1);
        break;
      }
      const code = await runSetup({
        homeDir,
        ...(configArg !== undefined && { configPath: configArg }),
        ...(deps.stdout !== undefined && { stdout: deps.stdout }),
        ...(deps.stderr !== undefined && { stderr: deps.stderr }),
        ...ttyPrompts(),
      });
      exit(code);
      break;
    }
    case 'sync-skills': {
      // Forward argv tokens that come after the subcommand name so
      // sync-skills' own minimist sees `--target=`, `--all-targets`, etc.
      const subCmdIdx = argv.indexOf('sync-skills');
      const subArgv = subCmdIdx >= 0 ? argv.slice(subCmdIdx + 1) : positional.slice(1);
      // Best-effort: sync-skills works with NO config at all (an explicit
      // --target still forces provisioning); a config, when present, supplies
      // the declared roster --target falls back to.
      const config = await loadConfig(configArg, deps).catch(() => null);
      const code = await runSyncSkills({
        argv: subArgv,
        homeDir: deps.homeDir?.() ?? os.homedir(),
        declared: (config as unknown as { clients?: DeclaredClientRoster } | null)?.clients,
        ifExists: opts['if-exists'] === true,
        silent: opts['silent'] === true,
        bestEffort: opts['best-effort'] === true,
        stdout: deps.stdout,
        stderr: deps.stderr,
      });
      exit(code);
      break;
    }
    case 'enable':
    case 'disable': {
      // Forward argv tokens after the subcommand name so toggle's own minimist
      // sees --target=, --all-targets, --dry-run, --json.
      const subCmdIdx = argv.indexOf(subcommand);
      const subArgv = subCmdIdx >= 0 ? argv.slice(subCmdIdx + 1) : positional.slice(1);
      const run = subcommand === 'disable' ? runDisable : runEnable;
      // Best-effort, same as sync-skills above: a config supplies the
      // declared roster --target falls back to, and its resolved path (when
      // one exists on disk already) is where `clients.<ClientId>` gets
      // persisted -- never invented from nothing.
      const config = await loadConfig(configArg, deps).catch(() => null);
      const configPath = resolveConfigPath(
        configArg,
        deps.env?.() ?? process.env,
        deps.cwd?.() ?? process.cwd(),
        deps.homeDir?.() ?? os.homedir(),
      );
      const code = await run({
        argv: subArgv,
        homeDir: deps.homeDir?.() ?? os.homedir(),
        declared: (config as unknown as { clients?: DeclaredClientRoster } | null)?.clients,
        configPath,
        stdout: deps.stdout,
        stderr: deps.stderr,
      });
      exit(code);
      break;
    }
    case 'clients': {
      const jsonFlag = opts['json'] === true;
      const config = await loadConfig(configArg, deps).catch(() => null);
      const text = await runClientsCommand({
        json: jsonFlag,
        config: (config as unknown as { clients?: DeclaredClientRoster; server?: { stateDir?: string; port?: number } } | null) ?? {},
        homeDir: deps.homeDir?.() ?? os.homedir(),
      });
      stdout(text.endsWith('\n') ? text : `${text}\n`);
      exit(0);
      break;
    }
    case 'telemetry': {
      // runTelemetry treats homeDir as the `.mma` directory itself. deps.homeDir()
      // (like every other subcommand) returns the raw home, so join `.mma` to
      // whichever base we resolve — not only to the os.homedir() default.
      const home = path.join(deps.homeDir?.() ?? os.homedir(), '.mma');
      const telemetrySubcommand = positional[1] ?? 'status';
      const validSubcommands = ['status', 'enable', 'disable', 'reset-id', 'dump-queue'];
      if (!validSubcommands.includes(telemetrySubcommand)) {
        stderr(`mma telemetry: unknown subcommand '${telemetrySubcommand}'\nValid: ${validSubcommands.join(', ')}\n`);
        exit(1);
        break;
      }
      const code = await runTelemetry({
        subcommand: telemetrySubcommand as 'status' | 'enable' | 'disable' | 'reset-id' | 'dump-queue',
        homeDir: home,
        stdout: deps.stdout,
        stderr: deps.stderr,
      });
      exit(code);
      break;
    }
    case 'plugin': {
      // Forward argv after the subcommand so plugin's own minimist sees
      // `build`, `--out=`, `--port=`, `--json`.
      const subCmdIdx = argv.indexOf('plugin');
      const subArgv = subCmdIdx >= 0 ? argv.slice(subCmdIdx + 1) : positional.slice(1);
      const config = await loadConfig(configArg, deps).catch(() => null);
      const code = runPlugin({
        argv: subArgv,
        version: readServerVersion(),
        port: config?.server.port ?? 7337,
        homeDir: deps.homeDir?.() ?? os.homedir(),
        stdout,
        stderr,
      });
      exit(code);
      break;
    }
    case 'mcp': {
      const nested = positional[1] ?? '';
      // `mcp install <ClientId>` runs that ONE client's full provisioning
      // (registration + skills) through the same service `mma clients` reads.
      // The former no-argument, Claude-Desktop-only form is REPLACED outright
      // — no alias, no silent default. Handled BEFORE loadConfig
      // failing hard: a missing/invalid config must not block validating the
      // client ID itself.
      if (nested === 'install') {
        const clientIdArg = positional[2];
        const config = await loadConfig(configArg, deps).catch(() => null);
        try {
          const result = await runMcpInstallCommand({
            clientId: clientIdArg,
            config: (config as unknown as { clients?: DeclaredClientRoster; server?: { stateDir?: string; port?: number } } | null) ?? {},
            homeDir: deps.homeDir?.() ?? os.homedir(),
          });
          stdout(`mma mcp install: '${result.clientId}' -> ${result.status}\n`);
          exit(0);
        } catch (err) {
          const message = err instanceof McpInstallCliError || err instanceof Error ? err.message : String(err);
          stderr(`mma mcp install: ${message}\n`);
          exit(1);
        }
        break;
      }
      // `mcp uninstall` manages Claude Desktop's MCP configuration only —
      // Desktop has no skills, so it is deliberately absent from the
      // provisioning-service-backed `mma disable`. Handled BEFORE loadConfig
      // on purpose: writing a config file must not require discovering (or
      // starting) a daemon.
      if (nested === 'uninstall') {
        const desktopCapability = CLIENT_CAPABILITIES.find((candidate) => candidate.id === 'claude-desktop')!;
        const writerInput = {
          capability: desktopCapability,
          homeDir: deps.homeDir?.() ?? os.homedir(),
          daemonPort: 0, // unused by the stdio bridge entry — Desktop has no URL
          cliEntrypoint: resolveCliEntrypoint(),
          execPath: process.execPath,
          platform: process.platform as string,
          appData: (deps.env?.() ?? process.env).APPDATA,
        };
        try {
          const result = await removeClientRegistration(writerInput);
          if (result.status === 'failed') {
            throw new Error(result.message ?? 'registration failed');
          }
          stdout(
            `mma mcp uninstall: ${result.changed === false ? 'no change needed' : 'updated'} ${result.path}\n`
            + 'Claude Desktop receives MCP configuration only — it has no MMA skills.\n',
          );
          exit(0);
        } catch (err) {
          stderr(`mma mcp uninstall: ${err instanceof Error ? err.message : String(err)}\n`);
          exit(1);
        }
        break;
      }
      if (nested !== '') {
        stderr(`mma mcp: unknown subcommand "${nested}" — expected "install", "uninstall", or no subcommand to run the bridge\n`);
        exit(1);
        break;
      }
      // `--client=<ClientId>` is validated BEFORE the config load: a typo must
      // report itself as a typo, not as whatever the config discovery happens
      // to fail with first. Omitting it stays valid — the daemon attributes
      // such a bridge as `other`, exactly as every pre-flag registration did.
      const clientArg = typeof opts['client'] === 'string' ? opts['client'] : undefined;
      if (clientArg !== undefined && !(MCP_BRIDGE_CLIENT_IDS as readonly string[]).includes(clientArg)) {
        stderr(`mma mcp: unknown --client "${clientArg}". Valid IDs: ${MCP_BRIDGE_CLIENT_IDS.join(', ')}\n`);
        exit(1);
        break;
      }
      const config = await loadConfig(configArg, deps);
      const daemonUrl = buildServerUrl(config.server.bind, config.server.port);
      const homeDir = deps.homeDir?.() ?? os.homedir();
      const env = deps.env?.() ?? process.env;
      const rl = createInterface({ input: process.stdin });
      // Buffer from creation: the bridge's startup (token, DNS pin, health preflight)
      // is async, and a host writes `initialize` the instant it spawns us. Iterating
      // `rl` directly would drop every line emitted before iteration attaches.
      const stdinLines = bufferedLines(rl);
      let code: number;
      try {
        code = await runMcpBridge({
          daemonUrl,
          env,
          homeDir,
          stdin: stdinLines,
          stdout,
          stderr,
          fetch,
          resolveHost: (hostname: string) => dnsLookup(hostname, { all: true }),
          readFile: (p: string) => fs.readFileSync(p, 'utf-8'),
          ...(clientArg !== undefined && { callerClient: clientArg as CallerClient }),
        });
      } finally {
        rl.close();
      }
      exit(code);
      break;
    }
    case 'journal': {
      const nested = positional[1] ?? '';
      if (nested !== 'reindex') {
        stderr(`mma journal: unknown subcommand '${nested}'\nValid: reindex\n`);
        exit(1);
        break;
      }
      const code = await runJournalReindex({
        cwd: deps.cwd?.() ?? process.cwd(),
        regenerateCatalog: opts['regenerate-catalog'] === true,
        stdout,
        stderr,
      });
      exit(code);
      break;
    }
    case 'initiatives': {
      const nested = positional[1] ?? '';
      if (nested !== 'import-bootstrap') {
        stderr(`mma initiatives: unknown subcommand "${nested}" — expected "import-bootstrap"\n`);
        exit(1);
        break;
      }
      const stem = typeof opts['stem'] === 'string' ? opts['stem'] : undefined;
      if (!stem) {
        stderr(`mma initiatives import-bootstrap: --stem <stem> is required\n`);
        exit(1);
        break;
      }
      const code = await runInitiativesImportBootstrap({
        cwd: deps.cwd?.() ?? process.cwd(),
        stem,
        loadConfig: () => loadConfig(configArg, deps),
        stdout: deps.stdout,
        stderr: deps.stderr,
      });
      exit(code);
      break;
    }
    default: {
      stderr(`Unknown command: ${subcommand}\nRun 'mma --help' for usage.\n`);
      exit(1);
    }
  }
}

// ── Bootstrap ──────────────────────────────────────────────────────────────

/**
 * Absolute path of THIS distribution's CLI entrypoint, for the Claude Desktop config.
 *
 * Uses the same `process.argv[1]` + realpath technique as {@link isMain}, for the same
 * reason: npm installs the bin as a symlink in `node_modules/.bin/`, so argv[1] points
 * at the link rather than the real file. Resolving it matters because the Desktop entry
 * must name the build doing the installing — a bare `mma` on PATH may be an older
 * install, producing a config that looks right and runs the wrong binary.
 */
export function resolveCliEntrypoint(): string {
  const fromModule = import.meta.url.startsWith('file://') ? fileURLToPath(import.meta.url) : '';
  const argv1 = process.argv[1];
  if (argv1) {
    try {
      return fs.realpathSync(path.resolve(argv1));
    } catch { /* fall through to the module path */ }
  }
  return fromModule;
}

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
    process.stderr.write(`mma: ${msg}\n`);
    process.exit(1);
  });
}

// Re-export for TypeScript consumers.
export type { MultiModelConfig };
