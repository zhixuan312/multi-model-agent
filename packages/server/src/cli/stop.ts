/**
 * stop.ts — `mma stop`.
 *
 * Stops the running daemon and waits for it to actually exit.
 *
 * WHY IT WAITS. The documented alternative was `pkill -f "mma serve"`, which
 * returns as soon as the signal is delivered. Every caller then had to guess how
 * long the port takes to free, and the common `pkill …; mma serve` one-liner
 * guessed zero — so the replacement daemon raced the predecessor for the port
 * and lost. A stop that has returned means the process is gone.
 *
 * WHY IT DOES NOT INTERRUPT WORK BY DEFAULT. The daemon's own SIGTERM handler
 * drains in-flight tasks, bounded by `server.limits.shutdownDrainMs`. `mma stop`
 * respects that: it allows the drain and reports what it is waiting for.
 * `--now` passes a short grace instead, which the daemon reads as the operator
 * being done waiting. `mma update` uses that short path, because the update
 * flow decided not to wait for running work.
 */
import { resolveDaemon, stopDaemon, type DaemonControlDeps } from './daemon-control.js';

export interface StopDeps extends DaemonControlDeps {
  /** Skip the daemon's drain window and stop as soon as it will let go. */
  now_?: boolean;
  json?: boolean;
  stdout?: (s: string) => boolean;
  stderr?: (s: string) => boolean;
  /** How long to allow the daemon's own drain. Overridden by `now_`. */
  graceMs?: number;
}

export const StopExitCode = { SUCCESS: 0, ERR_NOT_STOPPED: 1 } as const;

export async function runStop(deps: StopDeps): Promise<number> {
  const stdout = deps.stdout ?? process.stdout.write.bind(process.stdout);
  const stderr = deps.stderr ?? process.stderr.write.bind(process.stderr);
  const json = deps.json ?? false;

  const daemon = await resolveDaemon(deps);
  if (daemon === null) {
    if (json) stdout(JSON.stringify({ stopped: false, reason: 'not_running' }) + '\n');
    else stdout('mma stop: no daemon is running.\n');
    // Not an error. `mma stop` is idempotent by design: a script that stops
    // before installing must not fail because there was nothing to stop.
    return StopExitCode.SUCCESS;
  }

  if (!json) {
    const version = daemon.version ? ` version ${daemon.version}` : '';
    stdout(`mma stop: stopping daemon pid ${daemon.pid}${version} on ${daemon.bind}:${daemon.port}\n`);
    if (daemon.activeTasks !== null && daemon.activeTasks > 0) {
      stdout(`  ${daemon.activeTasks} task(s) in flight; waiting for the daemon to drain them\n`);
    }
    if (!daemon.reachable) {
      stdout('  the daemon is not answering /status; stopping it anyway\n');
    }
    if (daemon.source === 'port-scan') {
      stdout('  found by port owner, not by pidfile (started before pidfiles, or by hand)\n');
    }
  }

  const outcome = await stopDaemon(daemon.pid, {
    ...deps,
    graceMs: deps.now_ === true ? 1_000 : (deps.graceMs ?? 35_000),
  });

  if (!outcome.stopped) {
    // Two different failures wear `stopped: false`. Saying "survived SIGKILL" for a process we
    // never signalled would send the user hunting a wedged daemon that does not exist.
    const reason = outcome.notOurs === true ? 'not_an_mma_daemon' : 'still_running';
    if (json) stdout(JSON.stringify({ stopped: false, pid: outcome.pid, reason }) + '\n');
    else if (outcome.notOurs === true) {
      stderr(`mma stop: pid ${outcome.pid} is not an mma daemon; refusing to signal it.\n`);
      stderr('  the pidfile is stale, or the number was reused. Nothing was stopped.\n');
    } else stderr(`mma stop: pid ${outcome.pid} is still running after SIGKILL.\n`);
    return StopExitCode.ERR_NOT_STOPPED;
  }

  if (json) {
    stdout(JSON.stringify({ stopped: true, pid: outcome.pid, escalatedTo: outcome.escalatedTo }) + '\n');
  } else {
    // Report the escalation: needing SIGKILL means the daemon did not shut down
    // on its own, which is worth knowing even though the outcome is the same.
    const how = outcome.escalatedTo === 'SIGTERM' ? '' : ` (needed ${outcome.escalatedTo})`;
    stdout(`mma stop: stopped pid ${outcome.pid}${how}\n`);
  }
  return StopExitCode.SUCCESS;
}
