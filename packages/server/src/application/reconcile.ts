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
import { buildErrorEnvelope } from './result-shape.js';
import type { TaskType } from '@zhixuan92/multi-model-agent-core';

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = exists but not ours → alive. ESRCH = gone.
    return (err as { code?: string }).code === 'EPERM';
  }
}

/** True iff `pid` currently belongs to a codex worker. Guards against pid
 *  reuse: a recycled pid pointing at an unrelated process is never signalled. */
function isCodexProcess(pid: number): boolean {
  try {
    const cmd = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    return cmd.toLowerCase().includes('codex');
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

export function reconcileOnBoot(store: ExecutionStore, ownPid = process.pid): ReconcileOutcome {
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
    );
    if (store.interrupt(record.id, JSON.stringify(envelope))) interrupted += 1;
  }

  const prunedExpired = store.pruneExpired();
  return { interrupted, fencedWorkers, prunedExpired };
}
