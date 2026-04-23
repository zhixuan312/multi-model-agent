import * as fs from 'node:fs';
import * as path from 'node:path';

export type CwdValidationError = 'missing_cwd' | 'invalid_cwd' | 'cwd_not_dir';

export type CwdValidationResult =
  | { ok: true; canonicalCwd: string }
  | { ok: false; error: CwdValidationError; message: string };

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
  return { ok: true, canonicalCwd: canonical };
}
