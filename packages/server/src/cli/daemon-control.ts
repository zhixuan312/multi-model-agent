/**
 * daemon-control.ts — find the daemon, stop it, wait for it to come back.
 *
 * Shared by `mma stop`, `mma restart`, `mma doctor` and `mma update` so all four
 * agree on what "the daemon" means. Two copies of that answer is how two
 * commands start disagreeing about the same process.
 *
 * HOW IT IDENTIFIES THE DAEMON, and why in this order:
 *
 *   1. The pidfile the daemon wrote at startup (`../pidfile.ts`).
 *   2. Confirmation from the daemon itself: GET /status reports its own pid. A
 *      pid that matches the record is proof, not inference — this is the step
 *      that makes pid reuse harmless, and it works identically on every
 *      platform.
 *   3. If /status does not answer but the pid is alive, the daemon exists and is
 *      not serving: draining, or wedged. Still the daemon, still stoppable.
 *   4. Only if there is no usable record: ask the operating system who owns the
 *      port. POSIX only, because it shells out to `lsof`.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It never matches a command-line pattern.
 * `pkill -f "mma serve"` is what this module exists to replace: it missed any
 * daemon started as `node .../index.js serve`, and it matched unrelated
 * processes — including the shell running the kill — whose command line merely
 * contained the phrase.
 *
 * WHY THE PORT LOOKUP FILTERS ON LISTEN. `lsof -ti tcp:7337` returns every
 * process holding a socket on that port, which includes connected CLIENTS. A
 * stop built on that list would kill the user's editor along with the daemon.
 * `-sTCP:LISTEN` restricts it to the one process that owns the socket.
 */
import { execFileSync, spawn, type spawn as SpawnFn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { pidAlive } from '../pid-alive.js';
import { readPidfile, type DaemonRecord } from '../pidfile.js';

/** The subset of GET /status this module reads. */
export interface StatusSnapshot {
  version?: string;
  pid?: number;
  uptimeMs?: number;
  counters?: { activeTasks?: number };
}

/** Where the daemon's identity came from, so callers can report honestly. */
export type DaemonSource = 'pidfile' | 'port-scan';

export interface ResolvedDaemon {
  pid: number;
  port: number;
  bind: string;
  /** From /status when it answered, otherwise the pidfile's record, otherwise null. */
  version: string | null;
  source: DaemonSource;
  /** True when GET /status answered. False means the process is alive but not serving. */
  reachable: boolean;
  /** Tasks the daemon reported in flight. Null when it did not answer. */
  activeTasks: number | null;
}

export interface DaemonControlDeps {
  /** Home-expanded state directory holding the pidfile. */
  stateDir: string;
  /** Base URL of the daemon, e.g. 'http://127.0.0.1:7337'. */
  serverUrl: string;
  /** Bearer token for /status. /health needs none. */
  token: string;
  fetch?: typeof fetch;
  /** Test seam for the POSIX port-owner lookup. */
  lookupPortOwner?: (port: number) => number | null;
  /** Test seam for signalling. */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** Test seam for liveness. */
  isAlive?: (pid: number) => boolean;
  /** Test seam for "is this pid really a daemon". null = cannot verify (Windows). */
  verifyProcess?: (pid: number) => boolean | null;
  /** Test seam for the clock. */
  now?: () => number;
  /** Test seam for waiting. */
  sleep?: (ms: number) => Promise<void>;
  platform?: NodeJS.Platform;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Is `pid` actually an mma daemon?
 *
 * WHY THIS IS NOT OPTIONAL. Every other identity signal here can go stale. A
 * pidfile survives a crash, and the operating system reuses pids; `lsof` names
 * whoever holds the port, which after a crash may be a completely unrelated
 * program. Without this check `mma stop` would signal that program — the very
 * failure mode the module was written to remove, reintroduced one layer down.
 *
 * The technique is the one boot reconciliation already uses before terminating
 * a worker (`application/reconcile.ts`): read the command line and look for the
 * signature. Same discipline, same reason.
 *
 * @returns true / false on POSIX; `null` on Windows, where there is no cheap
 *          equivalent — callers treat null as "cannot verify" and fall back to
 *          the pidfile, which only a daemon ever writes.
 */
export function verifyDaemonProcess(pid: number, platform: NodeJS.Platform = process.platform): boolean | null {
  if (platform === 'win32') return null;
  try {
    const cmd = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toLowerCase();
    // Both halves are required. "serve" alone matches any server; the package
    // name alone matches `mma status` or a text editor holding the file open.
    return /\bserve\b/.test(cmd) && (cmd.includes('mma') || cmd.includes('multi-model-agent'));
  } catch {
    return false; // ps failed → the process is gone
  }
}

/** Ask the operating system which process is LISTENING on `port`. POSIX only. */
function lookupPortOwnerPosix(port: number): number | null {
  try {
    const out = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    // Multiple listeners on one port should be impossible; take the first and
    // ignore the rest rather than guessing which to signal.
    const first = out.split('\n').map((s) => s.trim()).filter(Boolean)[0];
    if (first === undefined) return null;
    const pid = Number(first);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null; // lsof missing, or nothing listening
  }
}

/**
 * GET /status, or null when the daemon does not answer.
 *
 * A short timeout on purpose: every caller is deciding whether a daemon is
 * there, and a hung socket must not stall a command that has a fallback.
 */
export async function probeStatus(
  serverUrl: string,
  token: string,
  fetcher: typeof fetch = fetch,
  timeoutMs = 2000,
): Promise<StatusSnapshot | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetcher(`${serverUrl.replace(/\/$/, '')}/status`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as StatusSnapshot;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Poll GET /health until it answers or the budget runs out.
 *
 * /health is auth-exempt and loopback-only (`http/server.ts`), so this needs no
 * token — which matters, because a caller that has just restarted the daemon
 * may be running before any token is loaded.
 */
export async function waitForHealth(
  serverUrl: string,
  timeoutMs = 20_000,
  deps: { fetch?: typeof fetch; now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<boolean> {
  const fetcher = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? realSleep;
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    try {
      const res = await fetcher(`${serverUrl.replace(/\/$/, '')}/health`, { method: 'GET' });
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  return false;
}

/** Find the running daemon, or null when nothing is running. */
export async function resolveDaemon(deps: DaemonControlDeps): Promise<ResolvedDaemon | null> {
  const fetcher = deps.fetch ?? fetch;
  const isAlive = deps.isAlive ?? pidAlive;
  const platform = deps.platform ?? process.platform;
  const lookupPortOwner = deps.lookupPortOwner
    ?? (platform === 'win32' ? () => null : lookupPortOwnerPosix);
  const verify = deps.verifyProcess ?? ((pid: number) => verifyDaemonProcess(pid, platform));

  const record: DaemonRecord | null = readPidfile(deps.stateDir);
  const status = await probeStatus(deps.serverUrl, deps.token, fetcher);

  if (record) {
    // The daemon confirmed its own identity. Nothing else needs checking.
    if (status?.pid === record.pid) {
      return {
        pid: record.pid,
        port: record.port,
        bind: record.bind,
        version: status.version ?? record.version,
        source: 'pidfile',
        reachable: true,
        activeTasks: status.counters?.activeTasks ?? null,
      };
    }
    // Alive but silent: draining, or wedged. Still ours to stop — but ONLY once
    // the process is confirmed to be a daemon. A pidfile outlives a crash, and
    // the operating system reuses pids, so "alive" on its own says nothing
    // about whose process this now is.
    if (isAlive(record.pid) && verify(record.pid) !== false) {
      return {
        pid: record.pid,
        port: record.port,
        bind: record.bind,
        version: record.version,
        source: 'pidfile',
        reachable: false,
        activeTasks: null,
      };
    }
    // Dead pid: the record is stale. Fall through rather than trust it — this is
    // the case where signalling on the recorded pid alone would hit whatever
    // unrelated process the operating system has since given that number to.
  }

  // No usable record. Something may still be serving — a daemon from a release
  // before pidfiles, or one started by hand.
  const port = record?.port ?? portFromUrl(deps.serverUrl);
  if (port === null) return null;

  // The daemon reporting its own pid is better evidence than anything the
  // operating system can be asked, and it is the ONLY evidence available on
  // Windows, where there is no port-owner lookup at all. Preferred over lsof
  // for the same reason /status confirms the pidfile above: it is the process
  // itself speaking.
  const owner = status?.pid ?? lookupPortOwner(port);
  if (owner === undefined || owner === null) return null;
  // A port owner that never answered /status is an unidentified process. It may
  // be a wedged daemon — or it may be an unrelated program that happens to have
  // bound this port after a crash. Signalling it on the strength of the port
  // number alone is exactly what `pkill` did wrong, so refuse instead.
  if (status === null && verify(owner) === false) return null;
  return {
    pid: owner,
    port,
    bind: hostFromUrl(deps.serverUrl) ?? '127.0.0.1',
    version: status?.version ?? null,
    source: 'port-scan',
    reachable: status !== null,
    activeTasks: status?.counters?.activeTasks ?? null,
  };
}

export interface StopOutcome {
  /** True when the process is gone. */
  stopped: boolean;
  pid: number;
  /** The strongest signal it took. Reported so a wedged daemon is visible. */
  escalatedTo: 'SIGTERM' | 'SIGTERM(second)' | 'SIGKILL' | 'none';
}

/**
 * Stop a daemon and wait for it to actually exit.
 *
 * The escalation follows the daemon's OWN contract rather than inventing one.
 * `cli/serve.ts` treats a first SIGTERM as "drain in-flight work, bounded by
 * server.limits.shutdownDrainMs" and a SECOND signal as "the operator is done
 * waiting, exit now". So: signal, wait `graceMs`, signal again, wait, and only
 * then SIGKILL. A caller that must not wait for a drain passes a small
 * `graceMs`; a caller that wants work finished passes a large one.
 *
 * Waiting is not optional. Returning while the port is still bound is what made
 * the old `pkill; mma serve` sequence fail: the replacement bound before the
 * predecessor released, and lost.
 */
export async function stopDaemon(
  pid: number,
  deps: DaemonControlDeps & { graceMs?: number; killAfterMs?: number },
): Promise<StopOutcome> {
  const isAlive = deps.isAlive ?? pidAlive;
  const kill = deps.kill ?? ((p: number, s: NodeJS.Signals) => { process.kill(p, s); });
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? realSleep;
  const graceMs = deps.graceMs ?? 10_000;
  const killAfterMs = deps.killAfterMs ?? 5_000;

  const verify = deps.verifyProcess ?? ((p: number) => verifyDaemonProcess(p, deps.platform ?? process.platform));

  const waitGone = async (budgetMs: number): Promise<boolean> => {
    const deadline = now() + budgetMs;
    while (now() < deadline) {
      if (!isAlive(pid)) return true;
      await sleep(100);
    }
    return !isAlive(pid);
  };

  /**
   * Re-confirm before EVERY signal, not just the first.
   *
   * Between two signals the daemon can exit and the operating system can hand
   * its pid to something else. Escalating on the bare number would then send
   * SIGKILL to an unrelated process — a rare window, but the consequence is
   * killing a program the user never asked to stop, so it is worth one `ps`.
   */
  const stillOurs = (): boolean => isAlive(pid) && verify(pid) !== false;

  // Including the FIRST signal. The pid was resolved before this call, and the daemon can exit and
  // have its number reused in between exactly as it can between escalations — the window is
  // smaller, not absent. Checking only liveness here meant the first SIGTERM could land on an
  // unrelated process, which is the one outcome this guard exists to prevent (audit M3-2).
  if (!stillOurs()) return { stopped: true, pid, escalatedTo: 'none' };

  try {
    kill(pid, 'SIGTERM');
  } catch {
    // Gone between the liveness check and the signal, or not ours to signal.
    return { stopped: !isAlive(pid), pid, escalatedTo: 'none' };
  }
  if (await waitGone(graceMs)) return { stopped: true, pid, escalatedTo: 'SIGTERM' };
  if (!stillOurs()) return { stopped: true, pid, escalatedTo: 'SIGTERM' };

  try {
    kill(pid, 'SIGTERM');
  } catch {
    return { stopped: !isAlive(pid), pid, escalatedTo: 'SIGTERM' };
  }
  if (await waitGone(killAfterMs)) return { stopped: true, pid, escalatedTo: 'SIGTERM(second)' };
  if (!stillOurs()) return { stopped: true, pid, escalatedTo: 'SIGTERM(second)' };

  try {
    kill(pid, 'SIGKILL');
  } catch {
    return { stopped: !isAlive(pid), pid, escalatedTo: 'SIGTERM(second)' };
  }
  const stopped = await waitGone(killAfterMs);
  return { stopped, pid, escalatedTo: 'SIGKILL' };
}

/**
 * Start a daemon that outlives this command.
 *
 * `detached` plus `unref` is what `nohup … &` was doing by hand, minus the two
 * ways that failed silently: output went to a file nobody read, and a start
 * that died immediately looked identical to one that worked. Callers pair this
 * with {@link waitForHealth}, so "started" means the daemon answered, not that
 * a process was spawned.
 *
 * @returns the child pid, or null when the spawn itself failed.
 */
export function startDaemonDetached(deps: {
  /** Absolute path to the CLI entry point (dist/cli/index.js in a real install). */
  cliPath: string;
  /** Where the daemon's own output goes. */
  logPath: string;
  /** Extra argv after `serve`, e.g. ['--config', '/path']. */
  args?: string[];
  execPath?: string;
  /** Node flags the parent was started with. Defaults to this process's own. */
  execArgv?: string[];
  spawn?: typeof SpawnFn;
  openLog?: (path: string) => number;
}): number | null {
  const execPath = deps.execPath ?? process.execPath;
  const spawnFn = deps.spawn ?? spawn;
  try {
    const openLog = deps.openLog ?? ((p: string) => {
      mkdirSync(dirname(p), { recursive: true });
      return openSync(p, 'a');
    });
    const fd = openLog(deps.logPath);
    try {
      const child = spawnFn(
        execPath,
        [...inheritableExecArgv(deps.execArgv ?? process.execArgv), deps.cliPath, 'serve', ...(deps.args ?? [])],
        { detached: true, stdio: ['ignore', fd, fd] },
      );
      child.unref();
      return child.pid ?? null;
    } finally {
      // The child holds its own duplicate of this descriptor, so the parent's
      // copy has no further use. Node does not close a caller-supplied stdio fd
      // for you, and `finally` covers the throwing-spawn path too.
      try { closeSync(fd); } catch { /* already closed, or never valid */ }
    }
  } catch {
    return null;
  }
}

/**
 * The parent's Node flags, minus the ones a detached daemon must not inherit.
 *
 * WHY FORWARD THEM AT ALL. `cliPath` is whatever entry point this process was
 * loaded from. In a real install that is `dist/cli/index.js` and bare `node`
 * runs it. Under a TypeScript runner it is a `.ts` file, which bare `node`
 * cannot execute at all — so a restart spawned a process that died instantly.
 * Forwarding the flags starts the child the same way the parent was started,
 * which is correct in both cases rather than only in production.
 *
 * WHY NOT ALL OF THEM. `--inspect` would make the daemon fight the parent for
 * the debugger port, and `--eval` would make it run a script instead of the
 * CLI. Neither is survivable, and both are easy to be running under by
 * accident.
 */
export function inheritableExecArgv(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] as string;
    const bare = flag.split('=')[0] as string;
    if (bare === '--eval' || bare === '-e' || bare === '--print' || bare === '-p') {
      // The script is the next element when it was not written as --eval=…
      if (!flag.includes('=')) i++;
      continue;
    }
    if (bare.startsWith('--inspect')) continue;
    out.push(flag);
  }
  return out;
}

function portFromUrl(url: string): number | null {
  try {
    const port = Number(new URL(url).port);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

function hostFromUrl(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
