import * as fs from 'node:fs';
import * as path from 'node:path';

export type CwdValidationError = 'missing_cwd' | 'invalid_cwd' | 'cwd_not_dir' | 'forbidden_cwd';

export type CwdValidationResult =
  | { ok: true; canonicalCwd: string }
  | { ok: false; error: CwdValidationError; message: string };

const SEP = path.sep;

/**
 * Walk each path component and check if any symlink points outside its
 * containing parent directory (symlink escape). Returns true if a symlink
 * escape is detected.
 *
 * Algorithm: build the path incrementally. At each component that is a symlink,
 * canonicalize both the parent directory and the symlink's resolved target via
 * realpathSync, then verify that the resolved target is a descendant of the
 * canonical parent. This handles macOS-style double-indirection (e.g. /var →
 * /private/var) without false positives.
 */
function hasSymlinkEscape(cwd: string): boolean {
  const parts = cwd.split(SEP).filter(Boolean); // ['a','b','c'] for /a/b/c
  // We track the "logical" accumulated path (not yet canonicalized) so lstat
  // finds the right inode even when earlier symlinks changed the real prefix.
  // We will resolve it when we need to compare.
  let logicalAccum: string = SEP;

  for (const part of parts) {
    const logicalCurrent = path.join(logicalAccum, part);
    // Resolve logicalAccum to its canonical form so lstat finds the right path.
    let canonAccum: string;
    try {
      canonAccum = fs.realpathSync(logicalAccum);
    } catch {
      return false;
    }
    const canonCurrent = path.join(canonAccum, part);

    let lstat: fs.Stats;
    try {
      lstat = fs.lstatSync(canonCurrent);
    } catch {
      // Path doesn't exist — validateCwd will catch this
      return false;
    }

    if (lstat.isSymbolicLink()) {
      let target: string;
      try {
        target = fs.readlinkSync(canonCurrent);
      } catch {
        return false;
      }

      // Resolve target relative to the canonical parent directory of the symlink.
      const resolvedTarget = path.isAbsolute(target)
        ? target
        : path.resolve(canonAccum, target);

      // Canonicalize the resolved target and the parent dir for stable comparison.
      let canonResolvedTarget: string;
      try {
        canonResolvedTarget = fs.realpathSync(resolvedTarget);
      } catch {
        // Target doesn't exist — validateCwd will catch this
        return false;
      }

      // The parent dir that should "contain" this symlink is canonAccum.
      const parentWithSep = canonAccum.endsWith(SEP) ? canonAccum : canonAccum + SEP;
      const resolvedWithSep = canonResolvedTarget.endsWith(SEP)
        ? canonResolvedTarget
        : canonResolvedTarget + SEP;

      if (!resolvedWithSep.startsWith(parentWithSep)) {
        // Symlink escapes its parent directory
        return true;
      }
      logicalAccum = resolvedTarget;
    } else {
      logicalAccum = logicalCurrent;
    }
  }
  return false;
}

export function validateCwd(cwd: string | undefined): CwdValidationResult {
  if (!cwd) return { ok: false, error: 'missing_cwd', message: "required query param 'cwd' not provided" };
  if (!path.isAbsolute(cwd)) return { ok: false, error: 'invalid_cwd', message: `cwd must be absolute: ${cwd}` };

  let canonical: string;
  try {
    canonical = fs.realpathSync(cwd);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { ok: false, error: 'cwd_not_dir', message: `cwd does not exist: ${cwd}` };
    if (code === 'EACCES' || code === 'EPERM') return { ok: false, error: 'cwd_not_dir', message: `cwd is not accessible (permission denied): ${cwd}` };
    return { ok: false, error: 'cwd_not_dir', message: `cwd cannot be resolved (${code ?? 'unknown error'}): ${cwd}` };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(canonical);
  } catch {
    return { ok: false, error: 'cwd_not_dir', message: `cwd realpath is not accessible: ${cwd} → ${canonical}` };
  }
  if (!stat.isDirectory()) return { ok: false, error: 'cwd_not_dir', message: `cwd is not a directory: ${cwd}` };

  // ── Symlink-escape check ──────────────────────────────────────────────────
  // Detect symlinks whose target escapes the containing parent directory.
  if (hasSymlinkEscape(cwd)) {
    return {
      ok: false,
      error: 'forbidden_cwd',
      message: `cwd contains a symlink that escapes its parent directory: ${cwd}`,
    };
  }

  return { ok: true, canonicalCwd: canonical };
}
