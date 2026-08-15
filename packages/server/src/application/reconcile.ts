// Boot reconciliation — crash fencing without execution resume.
//
// A dead daemon does not imply dead workers: detached codex process groups
// survive their parent. On startup, BEFORE the listener accepts requests:
//
//   1. find pending records owned by daemons that are no longer alive
//   2. terminate any surviving worker process group (verified by command line
//      before signalling, so a reused pid is never killed)
//   3. mark each execution `interrupted` with a structured retryable reason
//
// Order matters: fencing before marking means a retry can never race a
// straggler writing the same repo. Fencing is MORE important now than it was
// under worktrees: an orphaned worker no longer scribbles into a throwaway
// directory, it writes the caller's live checkout. Interrupted
// executions are terminal so the reaper no longer sees them as owned.
//
// Windows: process groups don't exist and `detached` is off there (workers die
// with the daemon), so fencing is a POSIX concern; records still reconcile.

import { execFileSync } from 'node:child_process';
import type { ExecutionStore } from './execution-store.js';
import type { InitiativeLinker } from './initiative-linker.js';
import { buildErrorEnvelope } from './result-shape.js';
import type { TaskType } from '@zhixuan92/multi-model-agent-core';
import { pidAlive } from '../pid-alive.js';

/**
 * True iff `pid` currently belongs to a codex worker. Guards against pid reuse: a recycled pid
 * pointing at an unrelated process is never signalled.
 *
 * The command line is matched against the binary MMA ACTUALLY SPAWNS, not the literal string
 * "codex". `codex-cli-launch.ts` runs `process.env.MMA_CODEX_BIN ?? 'codex'`, and
 * `configure-provider` actively tells operators to set that variable. Pointing it at a binary whose
 * path does not contain "codex" made this answer false for every real worker — so
 * `killStaleWorkerGroup` bailed, no process group was fenced, and the record was still marked
 * retryable. A resubmit would then race a live straggler in the caller's checkout, which is the one
 * outcome the fencing order at the top of this module exists to prevent.
 */
function codexBinaryTokens(): string[] {
  const configured = process.env.MMA_CODEX_BIN;
  // Always keep 'codex': the default, and still correct for an override that merely relocates it.
  const tokens = ['codex'];
  if (configured) {
    const basename = configured.split(/[\\/]/).pop()?.toLowerCase();
    if (basename) tokens.push(basename);
  }
  return tokens;
}

function isCodexProcess(pid: number): boolean {
  try {
    // `ps` does not exist on Windows, so this throws and the catch below reports "process gone" —
    // but the spawn is ATTEMPTED first, and an attempted spawn is what flashes the console.
    const cmd = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      windowsHide: true,
    }).toLowerCase();
    return codexBinaryTokens().some((token) => cmd.includes(token));
  } catch {
    return false; // ps failed → process gone
  }
}

/** SIGKILL a stale worker's process group. These are orphans of a CRASHED
 *  daemon — there is no graceful-shutdown obligation, and an immediate kill
 *  closes the window where a straggler could race a retry in the same repo. */
function killStaleWorkerGroup(workerPid: number): boolean {
  if (process.platform === 'win32') return false;
  if (!isCodexProcess(workerPid)) return false;
  try {
    process.kill(-workerPid, 'SIGKILL'); // negative pid = whole group (detached leader)
    return true;
  } catch {
    try {
      process.kill(workerPid, 'SIGKILL'); // group gone; leader may remain
      return true;
    } catch {
      return false;
    }
  }
}

interface ReconcileOutcome {
  interrupted: number;
  fencedWorkers: number;
  prunedExpired: number;
}

/**
 * `initiativeLinker`, when supplied, replays every unconsumed outbox row AFTER the fencing
 * loop below — including rows the fencing loop's own `interrupt()` calls just produced (a
 * linked Execution that was still pending when its owning daemon died reaches its terminal
 * outbox row here, not in `ExecutionRuntime`, since that daemon never resumes). Optional so a
 * daemon started without agent config (no `InitiativeRecordRuntime` wired — see
 * `http/server.ts`) still reconciles normally.
 */
export function reconcileOnBoot(
  store: ExecutionStore,
  ownPid = process.pid,
  initiativeLinker?: InitiativeLinker,
): ReconcileOutcome {
  let interrupted = 0;
  let fencedWorkers = 0;

  for (const record of store.stalePending(ownPid)) {
    // Owned by a still-alive daemon (e.g. a second instance on another port)?
    // Not ours to touch.
    if (pidAlive(record.daemonPid)) continue;

    // Fence FIRST: a surviving worker must be dead before the record becomes
    // retryable, or a resubmit could race the straggler in the same repo.
    if (record.workerPid !== null && killStaleWorkerGroup(record.workerPid)) {
      fencedWorkers += 1;
    }

    const envelope = buildErrorEnvelope(
      record.id,
      record.type as TaskType,
      {
        code: 'daemon_restarted',
        message: 'The MMA daemon restarted before this task completed. Submit the task again.',
        retryable: true,
      },
      'interrupted',
      record.method,
    );
    if (store.interrupt(record.id, JSON.stringify(envelope))) interrupted += 1;
  }

  const prunedExpired = store.pruneExpired();
  initiativeLinker?.replayOutbox();
  return { interrupted, fencedWorkers, prunedExpired };
}
