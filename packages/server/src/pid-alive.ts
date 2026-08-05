/**
 * Is a process still running?
 *
 * Signal 0 performs the permission and existence checks without delivering
 * anything. EPERM means the process exists but belongs to another user — alive.
 * ESRCH means it is gone.
 *
 * Shared rather than duplicated: boot reconciliation fences dead daemons with
 * this, and the provisioning lock decides whether a lock holder is a live peer
 * or a crashed one. Two copies of a liveness test is how the two answers start
 * disagreeing about the same pid.
 *
 * POSIX-only in the strict sense — on Windows the meaningful failure modes
 * differ — but `process.kill(pid, 0)` is implemented there too and returns the
 * same shape, so callers need no branch.
 */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string }).code === 'EPERM';
  }
}
