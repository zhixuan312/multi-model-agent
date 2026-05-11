/**
 * A4b §2b — terminal-stage cross-check of worker-reported `filesWritten`
 * against the actual filesystem.
 *
 * Inputs come from the per-task lifecycle state at the moment the task
 * transitions to terminal (cause `finished` or `cancelled`, not `error`).
 * Outputs are merged into the result envelope:
 *
 *   - `filesWritten` is trimmed to only entries whose `path.join(cwd, p)`
 *     stat()s successfully as a file or directory.
 *   - `filesWrittenMissing` carries the entries that didn't pass stat
 *     (defense-in-depth: also catches absolute paths if any slipped past
 *     the §2a filter).
 *   - `workerStatus = 'error'` + `errorCode = 'writes_unverifiable'` when
 *     all of:
 *       1. `filesWritten.length === 0` (post-stat trimming)
 *       2. `workerSelfAssessment === 'done'`
 *       3. `toolsMode === 'full'` (worker had write capability)
 *
 * The downgrade ONLY fires on the `done` claim with no evidence on a
 * write-capable worker. A worker that legitimately produced no
 * artifacts (e.g., a no-op task confirming "nothing to change") must
 * self-assess as `no_op`, not `done`. `readonly` / `none` workers are
 * also exempt — they aren't expected to produce artifacts.
 *
 * The optional `git status` merge (when autoCommit=true) is a follow-up
 * (see plan A4b.2 step 2 alternative) — out of scope for this initial
 * commit. autoCommit is accepted in the inputs for forward-compat.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface CrossCheckInputs {
  /** Canonical (realpath) cwd from request. */
  cwd: string;
  /** Already filtered per A4b §2a — relative paths only, no shell entries. */
  filesWritten: string[];
  workerSelfAssessment: 'done' | 'in_progress' | 'no_op' | null | undefined;
  toolsMode: 'full' | 'readonly' | 'none' | undefined;
  autoCommit: boolean | undefined;
  /** True iff the worker actually attempted any filesystem write — either a
   *  real path landed in `filesWritten`, the path-validity filter pushed at
   *  least one entry to `filesWrittenRejected`, or a shell heredoc fired.
   *  When false, the worker never tried to write — `writes_unverifiable` is
   *  a false positive (e.g., a chat-only response that didn't need a file). */
  writeAttempted?: boolean;
}

export interface CrossCheckResult {
  /** Possibly trimmed of nonexistent or absolute-path entries. */
  filesWritten: string[];
  /** Entries that didn't pass stat (or were absolute — sandbox guard). */
  filesWrittenMissing: string[];
  /** Set only when the downgrade fires. */
  workerStatus?: 'error';
  errorCode?: 'writes_unverifiable';
  errorMessage?: string;
}

const WRITES_UNVERIFIABLE_MESSAGE =
  "Worker self-assessed as 'done' but no verifiable file artifacts were " +
  "produced. Likely cause: writes were issued via shell commands (cat/echo/" +
  "python -c heredocs) that bypass the platform's file-write accounting.";

export function crossCheckFilesWritten(inputs: CrossCheckInputs): CrossCheckResult {
  const real: string[] = [];
  const missing: string[] = [];

  for (const entry of inputs.filesWritten) {
    // Defense-in-depth: reject absolutes here too. The path-validity
    // filter at A4b §2a should have already removed them, but if any
    // slip through, `path.join(cwd, '/etc/passwd')` would silently
    // resolve to `/etc/passwd` — sandbox escape. Categorize as missing
    // (not a real write under cwd).
    if (entry.startsWith('/')) {
      missing.push(entry);
      continue;
    }
    const absPath = path.join(inputs.cwd, entry);
    try {
      const st = fs.statSync(absPath);
      if (st.isFile() || st.isDirectory()) {
        real.push(entry);
      } else {
        missing.push(entry);
      }
    } catch {
      missing.push(entry);
    }
  }

  // Verdict downgrade per spec §2b step 3.
  let workerStatus: 'error' | undefined;
  let errorCode: 'writes_unverifiable' | undefined;
  let errorMessage: string | undefined;
  // When the caller can prove the worker never tried to write (no rejected
  // paths, no successful writes, no shell heredocs), skip the downgrade —
  // it's a false positive for chat-only responses. Default = true (preserve
  // pre-existing callers that don't pass the flag).
  const attempted = inputs.writeAttempted ?? true;
  if (
    real.length === 0 &&
    inputs.workerSelfAssessment === 'done' &&
    inputs.toolsMode === 'full' &&
    attempted
  ) {
    workerStatus = 'error';
    errorCode = 'writes_unverifiable';
    errorMessage = WRITES_UNVERIFIABLE_MESSAGE;
  }

  // The optional autoCommit-gated `git status --porcelain` merge is a
  // follow-up. Reading it here without implementing keeps the contract
  // forward-compat for callers that already pass autoCommit.
  void inputs.autoCommit;

  return {
    filesWritten: real,
    filesWrittenMissing: missing,
    ...(workerStatus !== undefined && { workerStatus }),
    ...(errorCode !== undefined && { errorCode }),
    ...(errorMessage !== undefined && { errorMessage }),
  };
}
