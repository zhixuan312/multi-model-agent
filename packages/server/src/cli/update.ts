/**
 * update.ts — `mma update`.
 *
 * One command that takes an installation from whatever version it is on to the
 * current one, and then names the applications the user must restart.
 *
 * WHY ONE COMMAND. Updating used to mean four, in order, with no verification:
 * install the package, kill and restart the daemon, refresh the Claude Code
 * marketplace, update the plugin. Two of the four failed silently — the kill
 * matched nothing unless the daemon happened to be started by typing
 * `mma serve`, and the restart then lost the port race with its own
 * predecessor. Nothing checked the result, so a user could believe they had
 * updated for days while running a stale daemon and a plugin several releases
 * behind.
 *
 * WHY IT RE-RUNS ITSELF AFTER INSTALLING. Phases after the install must run the
 * NEW code. The daemon does so automatically, because it is spawned fresh from
 * the CLI path. Skill synchronisation does not: it runs in-process, so an
 * update that stayed in the original process would write skill files from the
 * OLD bundle while reporting them refreshed. So the pre-install phases run
 * here, then this command re-executes the newly installed binary to finish.
 *
 * WHY IT DOES NOT WAIT FOR RUNNING WORK. Confirmed product decision: the update
 * proceeds, warns first, and reports what it interrupted afterwards. Boot
 * reconciliation marks those executions retryable. MMA cannot resubmit them —
 * the execution store keeps no prompt (`application/execution-store.ts`) — so
 * the report is a record, and the caller retries.
 *
 * WHAT IT CANNOT DO. It cannot restart Claude Code, Claude Desktop or Cursor.
 * Those are separate applications, and a client binds its plugin directory and
 * spawns its bridge process when it starts. Naming them in the final output is
 * the whole mitigation.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExecutionStore } from '../application/execution-store.js';
import { findEnabledMmaPlugin } from '../skill-install/plugin-conflict.js';
import { listEntries } from '../skill-install/manifest.js';
import {
  inheritableExecArgv,
  resolveDaemon,
  startDaemonDetached,
  stopDaemon,
  probeStatus,
  waitForHealth,
  type DaemonControlDeps,
} from './daemon-control.js';
import { runSyncSkills } from './sync-skills.js';
import { PACKAGE_NAME } from './doctor.js';

export const UpdateExitCode = {
  SUCCESS: 0,
  ERR_INSTALL: 1,
  ERR_MANAGER_UNKNOWN: 2,
  ERR_DAEMON: 3,
} as const;

export type PackageManager = 'npm' | 'pnpm' | 'bun';

export interface ManagerDetection {
  manager: PackageManager | null;
  /** False when the caller must be told to install by hand. */
  certain: boolean;
  /** The exact argv to run, for executing or for printing. */
  command: string[];
  /** Why detection landed where it did — printed when uncertain. */
  reason: string;
}

/**
 * Work out which package manager owns this installation.
 *
 * Inferred from the path this module was loaded from, because that is the one
 * piece of evidence that is always true: whatever installed the package chose
 * where it lives. Environment variables are not usable — `npm_config_user_agent`
 * is set only inside a package manager's own lifecycle scripts, and `mma update`
 * runs outside them.
 *
 * Returning `certain: false` is a real outcome, not a failure mode to avoid.
 * Guessing wrong installs to a location the user's shell does not resolve, and
 * the user is then told the update succeeded while the old binary still runs.
 * Stopping and printing the command is strictly better than that.
 */
export function detectPackageManager(deps: {
  modulePath?: string;
  hasCommand?: (cmd: string) => boolean;
  override?: PackageManager;
} = {}): ManagerDetection {
  const modulePath = deps.modulePath ?? fileURLToPath(import.meta.url);
  const hasCommand = deps.hasCommand ?? defaultHasCommand;
  const spec = `${PACKAGE_NAME}@latest`;

  const commandFor = (m: PackageManager): string[] =>
    m === 'npm' ? ['npm', 'install', '-g', spec]
      : m === 'pnpm' ? ['pnpm', 'add', '-g', spec]
        : ['bun', 'add', '-g', spec];

  if (deps.override) {
    return {
      manager: deps.override,
      certain: hasCommand(deps.override),
      command: commandFor(deps.override),
      reason: `--package-manager=${deps.override}`,
    };
  }

  const p = modulePath.replace(/\\/g, '/');
  let inferred: PackageManager | null = null;
  let reason = '';
  if (p.includes('/.bun/install/global/') || p.includes('/.bun/')) {
    inferred = 'bun';
    reason = 'installed under a bun global directory';
  } else if (/\/pnpm(-global)?\//.test(p) || p.includes('/.pnpm/')) {
    inferred = 'pnpm';
    reason = 'installed under a pnpm global store';
  } else if (p.includes('/node_modules/')) {
    inferred = 'npm';
    reason = 'installed under a node_modules directory';
  }

  if (inferred === null) {
    return {
      manager: null,
      certain: false,
      command: commandFor('npm'),
      // A source checkout, a bundled build, or something else entirely. An
      // install here would not replace what is actually running.
      reason: `cannot tell how this package was installed (running from ${modulePath})`,
    };
  }
  if (!hasCommand(inferred)) {
    return {
      manager: inferred,
      certain: false,
      command: commandFor(inferred),
      reason: `looks like a ${inferred} install, but '${inferred}' is not on PATH`,
    };
  }
  return { manager: inferred, certain: true, command: commandFor(inferred), reason };
}

function defaultHasCommand(cmd: string): boolean {
  try {
    const probe = process.platform === 'win32' ? 'where' : 'which';
    execFileSync(probe, [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export interface UpdateDeps extends DaemonControlDeps {
  cliVersion: string;
  homeDir: string;
  /** Absolute path to the CLI entry point, used to re-execute and to spawn the daemon. */
  cliPath: string;
  /** Where a restarted daemon writes its output. */
  logPath: string;
  /** Passed through to `serve` when starting the replacement. */
  serveArgs?: string[];
  /** Skip the package install (the user manages the package another way). */
  noInstall?: boolean;
  /** Force a package manager instead of inferring one. */
  packageManager?: PackageManager;
  /** Internal: this process IS the re-executed one, so skip straight to phase 2. */
  postInstall?: boolean;
  /** Version recorded before the install, threaded through the re-execution. */
  previousVersion?: string;
  json?: boolean;
  stdout?: (s: string) => boolean;
  stderr?: (s: string) => boolean;
  // ── seams ──
  detect?: typeof detectPackageManager;
  runInstall?: (command: string[]) => { ok: boolean; output: string };
  reexec?: (argv: string[]) => number;
  startDaemon?: typeof startDaemonDetached;
  syncSkills?: typeof runSyncSkills;
  updatePlugin?: (pluginKey: string) => { ran: boolean; ok: boolean; output: string };
  openStore?: (dbPath: string) => Pick<ExecutionStore, 'interruptedSince' | 'close'>;
  now?: () => number;
}

/** Same label style as `mma doctor`, so the two commands read as one tool. */
const pad = (s: string): string => (s + ' ').padEnd(14, '.');

export async function runUpdate(deps: UpdateDeps): Promise<number> {
  const stdout = deps.stdout ?? process.stdout.write.bind(process.stdout);
  const stderr = deps.stderr ?? process.stderr.write.bind(process.stderr);
  const now = deps.now ?? Date.now;

  if (deps.postInstall === true) return runPostInstallPhases(deps, stdout, stderr, now);

  stdout('\n');

  // ── phase 1: what is running now ───────────────────────────────────────
  const before = await resolveDaemon(deps);
  if (before === null) {
    stdout(`  ${pad('Daemon')} not running\n`);
  } else {
    const version = before.version ?? 'unknown';
    const tasks = before.activeTasks ?? 0;
    stdout(`  ${pad('Daemon')} ${version} running, ${tasks} task(s) in flight\n`);
    // ── phase 2: warn BEFORE anything destructive, while Ctrl-C still helps ──
    if (tasks > 0) {
      stdout(`  ${' '.repeat(14)} WARNING: ${tasks} running task(s) will be interrupted\n`);
    }
  }

  // ── phase 3: install ───────────────────────────────────────────────────
  if (deps.noInstall === true) {
    stdout(`  ${pad('Package')} ${deps.cliVersion} (install skipped, --no-install)\n`);
  } else {
    const detection = (deps.detect ?? detectPackageManager)({ override: deps.packageManager });
    if (!detection.certain) {
      stderr(
        `\nmma update: ${detection.reason}.\n` +
        `  Install by hand, then run 'mma update --no-install' to finish:\n\n` +
        `    ${detection.command.join(' ')}\n\n`,
      );
      return UpdateExitCode.ERR_MANAGER_UNKNOWN;
    }
    stdout(`  ${pad('Package')} ${detection.manager} detected, installing…\n`);
    const install = (deps.runInstall ?? defaultRunInstall)(detection.command);
    if (!install.ok) {
      stderr(`\nmma update: install failed.\n${install.output}\n`);
      return UpdateExitCode.ERR_INSTALL;
    }
  }

  // ── phase 4: continue from the newly installed binary ──────────────────
  // Everything after this point must run the new code. Re-executing is the only
  // way to guarantee that for the in-process steps, chiefly skill sync.
  const reexec = deps.reexec ?? defaultReexec;
  const argv = [
    deps.cliPath,
    'update',
    '--post-install',
    `--previous-version=${deps.cliVersion}`,
    // The second half must act on the SAME daemon as the first. Without the
    // config, `mma update --config /custom` would restart whatever the default
    // config points at and report that as the update.
    ...(deps.serveArgs ?? []),
    ...(deps.json === true ? ['--json'] : []),
    ...(deps.noInstall === true ? ['--no-install'] : []),
  ];
  return reexec(argv);
}

/** Phases 5 to 11 — always running the newly installed code. */
async function runPostInstallPhases(
  deps: UpdateDeps,
  stdout: (s: string) => boolean,
  stderr: (s: string) => boolean,
  now: () => number,
): Promise<number> {
  const previous = deps.previousVersion ?? null;
  if (previous !== null && previous !== deps.cliVersion) {
    stdout(`  ${' '.repeat(14)} ${previous} → ${deps.cliVersion} installed\n`);
  } else if (previous !== null) {
    stdout(`  ${' '.repeat(14)} already at ${deps.cliVersion}\n`);
  }

  // ── phase 5: stop ──────────────────────────────────────────────────────
  const before = await resolveDaemon(deps);
  const restartCutoff = now();
  if (before !== null) {
    const outcome = await stopDaemon(before.pid, { ...deps, graceMs: 1_000 });
    if (!outcome.stopped) {
      stderr(`\nmma update: could not stop daemon pid ${outcome.pid}. Nothing else was changed.\n`);
      return UpdateExitCode.ERR_DAEMON;
    }
  }

  // ── phase 6 + 7: start, wait for health, confirm the version changed ────
  if (before === null) {
    // Leave the machine as it was found. Starting a daemon the user had not
    // started is a change they did not ask this command to make.
    stdout(`  ${pad('Daemon')} was not running; left stopped\n`);
  } else {
    const pid = (deps.startDaemon ?? startDaemonDetached)({
      cliPath: deps.cliPath,
      logPath: deps.logPath,
      args: deps.serveArgs,
    });
    if (pid === null) {
      stderr(`\nmma update: could not start the daemon. See ${deps.logPath}.\n`);
      return UpdateExitCode.ERR_DAEMON;
    }
    const healthy = await waitForHealth(deps.serverUrl, 20_000, deps);
    if (!healthy) {
      stderr(`\nmma update: the daemon did not answer /health. See ${deps.logPath}.\n`);
      return UpdateExitCode.ERR_DAEMON;
    }
    const status = await probeStatus(deps.serverUrl, deps.token, deps.fetch ?? fetch);
    const running = status?.version ?? 'unknown';
    stdout(`  ${pad('Daemon')} restarted, /status reports ${running}\n`);
    if (running !== deps.cliVersion) {
      // Not fatal, but never silent: this is the exact skew the command exists
      // to remove, and it means something else is serving.
      stderr(
        `  ${' '.repeat(14)} WARNING: the daemon reports ${running} but the installed package is ` +
        `${deps.cliVersion}. Another daemon may own the port.\n`,
      );
    }

    // ── phase 8: report what the restart destroyed ───────────────────────
    reportInterrupted(deps, restartCutoff, stdout);
  }

  // ── phase 9: skill files ───────────────────────────────────────────────
  const pluginKey = findEnabledMmaPlugin(deps.homeDir);
  try {
    // argv: [] on purpose — runSyncSkills defaults to process.argv, which here
    // carries `update --post-install` and would fail to parse.
    await (deps.syncSkills ?? runSyncSkills)({ argv: [], silent: true, bestEffort: true, ifExists: true });
  } catch {
    /* bestEffort swallows inside; belt and braces */
  }
  stdout(`  ${pad('Skill files')}`);
  const byClient = new Map<string, number>();
  try {
    for (const entry of listEntries(deps.homeDir)) {
      for (const target of entry.targets) byClient.set(target, (byClient.get(target) ?? 0) + 1);
    }
  } catch {
    /* an unreadable manifest is doctor's problem to explain, not update's */
  }
  const parts: string[] = [];
  if (pluginKey) parts.push('Claude Code: provided by the plugin');
  for (const [client, count] of [...byClient.entries()].sort()) {
    parts.push(`${client}: ${count} refreshed`);
  }
  stdout(parts.length > 0 ? ` ${parts.join('; ')}\n` : ' nothing installed\n');

  // ── phase 10: the plugin ───────────────────────────────────────────────
  const restartTargets = new Set<string>([...byClient.keys()]);
  if (pluginKey !== null) {
    restartTargets.add('claude-code');
    const result = (deps.updatePlugin ?? defaultUpdatePlugin)(pluginKey);
    if (result.ran && result.ok) {
      stdout(`  ${pad('Plugin')} ${pluginKey} updated\n`);
    } else if (result.ran) {
      // Reported, never fatal: MMA does not own Claude Code's CLI, and a
      // failure there must not undo a successful engine update.
      stderr(`  ${pad('Plugin')} could not be updated automatically:\n${indent(result.output)}\n`);
      printPluginCommands(pluginKey, stderr);
    } else {
      stdout(`  ${pad('Plugin')} ${pluginKey} is installed, but the 'claude' command was not found\n`);
      printPluginCommands(pluginKey, stdout);
    }
  }

  // ── phase 11: what the user must still do ──────────────────────────────
  stdout('\n');
  if (restartTargets.size === 0) {
    stdout('  Done. No client applications need restarting.\n\n');
  } else {
    stdout('  Restart these applications to load the update:\n');
    for (const client of [...restartTargets].sort()) {
      const why = client === 'claude-code' ? 'new plugin version' : 'new skill files';
      stdout(`    ${client.padEnd(16, ' ')}${why}\n`);
    }
    stdout('\n');
  }
  return UpdateExitCode.SUCCESS;
}

/**
 * Print the executions boot reconciliation just marked interrupted.
 *
 * Read straight from the durable store rather than from an endpoint, because
 * there is no read-by-state on the wire and adding one would be a second
 * feature. Failures here are swallowed: an unreadable store must not fail an
 * update that has already succeeded.
 */
function reportInterrupted(deps: UpdateDeps, since: number, stdout: (s: string) => boolean): void {
  let store: Pick<ExecutionStore, 'interruptedSince' | 'close'> | null = null;
  try {
    const dbPath = path.join(deps.stateDir, 'executions.db');
    if (!fs.existsSync(dbPath)) return;
    // ttlMs is required by the constructor but only ever read when the store
    // TERMINALIZES a row, to compute its expiry. This connection only reads, so
    // the value cannot affect anything; it is not worth loading the config for.
    store = (deps.openStore ?? ((p: string) => new ExecutionStore({ dbPath: p, ttlMs: 0 })))(dbPath);
    const rows = store.interruptedSince(since);
    if (rows.length === 0) return;
    stdout(`  ${pad('Interrupted')} ${rows.length} task(s), not resumable\n`);
    for (const row of rows) {
      stdout(`    ${row.id.slice(0, 8)}  ${row.type.padEnd(14, ' ')}${row.cwd}\n`);
    }
    stdout(
      `    MMA does not store task prompts, so these cannot be re-run\n` +
      `    automatically. Ask your client to submit them again.\n`,
    );
  } catch {
    /* best-effort */
  } finally {
    try { store?.close(); } catch { /* best-effort */ }
  }
}

function printPluginCommands(pluginKey: string, write: (s: string) => boolean): void {
  const marketplace = pluginKey.split('@')[1] ?? '';
  write(
    `    Run these, then restart Claude Code:\n` +
    `      claude plugin marketplace update ${marketplace}\n` +
    `      claude plugin update ${pluginKey}\n`,
  );
}

function indent(s: string): string {
  return s.split('\n').map((l) => `    ${l}`).join('\n');
}

function defaultRunInstall(command: string[]): { ok: boolean; output: string } {
  const [cmd, ...args] = command;
  const res = spawnSync(cmd as string, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return {
    ok: res.status === 0,
    output: `${res.stdout ?? ''}${res.stderr ?? ''}`.trim(),
  };
}

function defaultReexec(argv: string[]): number {
  // Same reason startDaemonDetached forwards them: the entry point is whatever
  // this process was loaded from, and bare `node` cannot run all of them.
  const res = spawnSync(process.execPath, [...inheritableExecArgv(process.execArgv), ...argv], { stdio: 'inherit' });
  return res.status ?? UpdateExitCode.ERR_INSTALL;
}

function defaultUpdatePlugin(pluginKey: string): { ran: boolean; ok: boolean; output: string } {
  if (!defaultHasCommand('claude')) return { ran: false, ok: false, output: '' };
  const marketplace = pluginKey.split('@')[1];
  const out: string[] = [];
  if (marketplace) {
    const a = spawnSync('claude', ['plugin', 'marketplace', 'update', marketplace], { encoding: 'utf8' });
    out.push(`${a.stdout ?? ''}${a.stderr ?? ''}`.trim());
    if (a.status !== 0) return { ran: true, ok: false, output: out.join('\n').trim() };
  }
  const b = spawnSync('claude', ['plugin', 'update', pluginKey], { encoding: 'utf8' });
  out.push(`${b.stdout ?? ''}${b.stderr ?? ''}`.trim());
  return { ran: true, ok: b.status === 0, output: out.join('\n').trim() };
}
