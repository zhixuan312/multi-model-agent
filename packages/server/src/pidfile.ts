/**
 * pidfile.ts — the daemon's own record of itself.
 *
 * WHY THIS EXISTS. Before it, the only documented way to stop the daemon was
 * `pkill -f "mma serve"`. That pattern matches the command line, so it silently
 * missed any daemon started another way (`node .../dist/cli/index.js serve`,
 * `npm run serve`), and it matched unrelated processes whose command line merely
 * contained the phrase — including the shell running the kill itself. A pidfile
 * replaces a guess about text with a fact the daemon wrote down.
 *
 * WHY A RECORD AND NOT JUST A NUMBER. A bare pid cannot be trusted: the
 * operating system reuses pids, so a stale file can name an unrelated process
 * that would then be signalled. The record carries `port` so a caller can ask
 * the running daemon to identify itself over `/status` before acting, and
 * `version` so it can say what it is about to stop.
 *
 * WHAT bootId IS AND IS NOT. It discriminates successive daemons that reuse a
 * pid IN THIS FILE — a record from a previous boot is distinguishable from the
 * current one. It is NOT part of the identity handshake: `/status` does not
 * report it, so no caller can compare the two. The pid-reuse defence that
 * actually runs is `verifyDaemonProcess` in `cli/daemon-control.ts`, which
 * reads the process command line before signalling — the same rule boot
 * reconciliation follows for worker pids (`application/reconcile.ts`): verify
 * before you signal. Adding `bootId` to `/status` would strengthen the
 * reachable-daemon branch, but it would not help the branches that matter most,
 * because those are reached precisely when `/status` does not answer.
 *
 * WHY IT LIVES IN stateDir. `executions.db` is already there, and both answer
 * the same question — what was this daemon doing. Keeping them together means
 * one directory to point at when diagnosing, and one directory a test can
 * redirect.
 *
 * BEST EFFORT ON WRITE, STRICT ON READ. A daemon that cannot write its pidfile
 * still serves; it only loses the fast path for `mma stop`. A reader that finds
 * a malformed file treats it as absent rather than guessing, because the
 * consequence of guessing is signalling the wrong process.
 */
import * as fs from 'node:fs';
import { dirname, join } from 'node:path';

/** What the daemon records about itself at startup. */
export interface DaemonRecord {
  /** Process id of the daemon. */
  pid: number;
  /** Port it bound. Needed to confirm identity via /status, and to fall back to a port lookup. */
  port: number;
  /** Bind address, for the same confirmation. */
  bind: string;
  /** Server version, so a caller can report what it is about to stop. */
  version: string;
  /** Discriminates successive daemons that happen to reuse a pid. */
  bootId: string;
  /** Epoch milliseconds at startup. */
  startedAt: number;
}

/** The one path this module owns. `stateDir` must already be home-expanded. */
export function pidfilePath(stateDir: string): string {
  return join(stateDir, 'daemon.pid');
}

/**
 * Record the running daemon. Never throws: a failed write costs the fast path
 * for `mma stop`, not the daemon.
 *
 * @returns true when the record was written.
 */
export function writePidfile(stateDir: string, record: DaemonRecord): boolean {
  const path = pidfilePath(stateDir);
  try {
    fs.mkdirSync(dirname(path), { recursive: true });
    // 0o600: the record names a port and a pid on the user's own machine. It is
    // not a credential, but nothing else needs to read it either.
    fs.writeFileSync(path, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the record, or null when it is absent, unreadable, or does not parse
 * into a complete record.
 *
 * Incomplete is treated as absent on purpose. A half-written file (a daemon
 * killed mid-write) must not produce a record with a pid and a missing port,
 * because a caller would then fall back to signalling on the pid alone.
 */
export function readPidfile(stateDir: string): DaemonRecord | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(pidfilePath(stateDir), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const r = parsed as Partial<DaemonRecord>;
    if (!Number.isInteger(r.pid) || (r.pid as number) <= 0) return null;
    if (!Number.isInteger(r.port) || (r.port as number) <= 0) return null;
    if (typeof r.bind !== 'string' || r.bind === '') return null;
    if (typeof r.version !== 'string' || r.version === '') return null;
    if (typeof r.bootId !== 'string' || r.bootId === '') return null;
    if (!Number.isFinite(r.startedAt)) return null;
    return r as DaemonRecord;
  } catch {
    return null;
  }
}

/** Remove the record. Never throws — called on a shutdown path that must finish. */
export function removePidfile(stateDir: string): void {
  try {
    fs.rmSync(pidfilePath(stateDir), { force: true });
  } catch {
    /* best-effort */
  }
}
