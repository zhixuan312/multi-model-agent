/**
 * restart.ts — `mma restart`.
 *
 * Stop the daemon, start a replacement, and do not return until the replacement
 * answers.
 *
 * WHY THIS IS ONE COMMAND. Done by hand it is a sequence with two silent
 * failure modes, and the previously documented form
 * (`pkill -f "mma serve"; nohup mma serve > /tmp/mma.log 2>&1 &`) hit both:
 * the kill matched nothing when the daemon was started any other way, and the
 * start then failed on the bound port with its output redirected into a file
 * nobody reads. Composing the two steps here means the failure of either is
 * reported, and "restarted" is asserted against /health rather than assumed.
 *
 * WHAT IT DOES NOT DO. It does not preserve in-flight work. Boot reconciliation
 * marks anything the old daemon was running as `interrupted` with a retryable
 * reason, and MMA cannot resubmit those tasks because the execution store keeps
 * no prompt — see `application/execution-store.ts`. The caller retries.
 */
import {
  resolveDaemon,
  startDaemonDetached,
  stopDaemon,
  waitForHealth,
  type DaemonControlDeps,
} from './daemon-control.js';

export interface RestartDeps extends DaemonControlDeps {
  /** Absolute path to the CLI entry point. */
  cliPath: string;
  /** Where the new daemon's output goes. */
  logPath: string;
  /** Extra argv passed through to `serve`, e.g. ['--config', '/path']. */
  serveArgs?: string[];
  /** Skip the daemon's drain window. */
  now_?: boolean;
  json?: boolean;
  stdout?: (s: string) => boolean;
  stderr?: (s: string) => boolean;
  healthTimeoutMs?: number;
  startDaemon?: typeof startDaemonDetached;
}

export const RestartExitCode = { SUCCESS: 0, ERR_NOT_STOPPED: 1, ERR_NOT_HEALTHY: 2 } as const;

export async function runRestart(deps: RestartDeps): Promise<number> {
  const stdout = deps.stdout ?? process.stdout.write.bind(process.stdout);
  const stderr = deps.stderr ?? process.stderr.write.bind(process.stderr);
  const json = deps.json ?? false;
  const startDaemon = deps.startDaemon ?? startDaemonDetached;
  const lines: string[] = [];
  const say = (s: string): void => { if (!json) stdout(s); else lines.push(s.trim()); };

  const before = await resolveDaemon(deps);
  if (before === null) {
    say('mma restart: no daemon was running; starting one\n');
  } else {
    const version = before.version ? ` version ${before.version}` : '';
    say(`mma restart: stopping pid ${before.pid}${version}\n`);
    if (before.activeTasks !== null && before.activeTasks > 0) {
      // Say this BEFORE the stop, while the user can still interrupt.
      say(`  WARNING: ${before.activeTasks} task(s) in flight will be interrupted\n`);
    }
    const outcome = await stopDaemon(before.pid, {
      ...deps,
      graceMs: deps.now_ === true ? 1_000 : 35_000,
    });
    if (!outcome.stopped) {
      if (json) stdout(JSON.stringify({ restarted: false, reason: 'still_running', pid: outcome.pid }) + '\n');
      else stderr(`mma restart: pid ${outcome.pid} is still running after SIGKILL; not starting a replacement.\n`);
      // Starting anyway would just fail on the bound port, and the second
      // failure would obscure the first.
      return RestartExitCode.ERR_NOT_STOPPED;
    }
    const how = outcome.escalatedTo === 'SIGTERM' ? '' : ` (needed ${outcome.escalatedTo})`;
    say(`  stopped${how}\n`);
  }

  const pid = startDaemon({
    cliPath: deps.cliPath,
    logPath: deps.logPath,
    args: deps.serveArgs,
  });
  if (pid === null) {
    if (json) stdout(JSON.stringify({ restarted: false, reason: 'spawn_failed' }) + '\n');
    else stderr(`mma restart: could not start a daemon. See ${deps.logPath}.\n`);
    return RestartExitCode.ERR_NOT_HEALTHY;
  }

  const healthy = await waitForHealth(deps.serverUrl, deps.healthTimeoutMs ?? 20_000, deps);
  if (!healthy) {
    if (json) stdout(JSON.stringify({ restarted: false, reason: 'unhealthy', pid }) + '\n');
    else {
      stderr(`mma restart: started pid ${pid} but it did not answer /health in time.\n`);
      stderr(`  Check ${deps.logPath}.\n`);
    }
    return RestartExitCode.ERR_NOT_HEALTHY;
  }

  // Re-resolve rather than trusting the spawn: the pid that answers is the fact
  // worth reporting, and it also confirms the new daemon wrote its pidfile.
  const after = await resolveDaemon(deps);

  // /health answering proves SOMETHING is serving, not that it is the process
  // this command started. A second concurrent `mma restart`, or a daemon
  // someone else launched, can win the port — and both invocations would then
  // report success for a replacement that never became the daemon.
  if (after !== null && after.pid !== pid) {
    if (json) {
      stdout(JSON.stringify({ restarted: false, reason: 'port_taken_by_other', spawnedPid: pid, ownerPid: after.pid }) + '\n');
    } else {
      stderr(
        `mma restart: started pid ${pid}, but ${after.bind}:${after.port} is owned by pid ${after.pid}.\n` +
        `  Another restart or daemon won the port. Run 'mma doctor' to see what is serving.\n`,
      );
    }
    return RestartExitCode.ERR_NOT_HEALTHY;
  }

  if (json) {
    stdout(JSON.stringify({
      restarted: true,
      previousPid: before?.pid ?? null,
      pid: after?.pid ?? pid,
      version: after?.version ?? null,
      notes: lines,
    }) + '\n');
  } else {
    const version = after?.version ? ` version ${after.version}` : '';
    stdout(`mma restart: running as pid ${after?.pid ?? pid}${version}\n`);
  }
  return RestartExitCode.SUCCESS;
}
